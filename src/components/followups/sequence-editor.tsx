'use client';

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { MessageTemplate, Tag } from '@/types';
import {
  buildVars,
  formatDelayRange,
  FOLLOWUP_VARIABLES,
  interpolate,
} from '@/lib/followups/timing';
import { FOLLOWUP_LIMITS, type FollowupSequence, type FollowupStep } from '@/lib/followups/types';
import { TagMultiSelect } from './shared';

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Free-form messages are rejected by WhatsApp after this many minutes. */
const WINDOW_MINUTES = 24 * 60 - 5;

interface StepDraft {
  key: string;
  min: string;
  max: string;
  unit: Unit;
  message_type: 'text' | 'template';
  message_text: string;
  template_name: string;
  template_language: string;
  template_variables: string[];
}

let keyCounter = 0;
const nextKey = () => `step-${++keyCounter}`;

function pickUnit(min: number, max: number): Unit {
  if (min % 1440 === 0 && max % 1440 === 0) return 'days';
  if (min % 60 === 0 && max % 60 === 0) return 'hours';
  return 'minutes';
}

function toDraft(step: FollowupStep): StepDraft {
  const unit = pickUnit(step.delay_min_minutes, step.delay_max_minutes);
  const div = UNIT_MINUTES[unit];
  return {
    key: nextKey(),
    min: String(step.delay_min_minutes / div),
    max: String(step.delay_max_minutes / div),
    unit,
    message_type: step.message_type,
    message_text: step.message_text ?? '',
    template_name: step.template_name ?? '',
    template_language: step.template_language ?? '',
    template_variables: step.template_variables,
  };
}

function blankDraft(previousMaxMinutes: number): StepDraft {
  const minutes = Math.max(60, previousMaxMinutes + 60);
  const unit = pickUnit(minutes, minutes);
  const div = UNIT_MINUTES[unit];
  return {
    key: nextKey(),
    min: String(minutes / div),
    max: String(minutes / div),
    unit,
    message_type: 'text',
    message_text: '',
    template_name: '',
    template_language: '',
    template_variables: [],
  };
}

function draftMinutes(d: StepDraft): { min: number; max: number } {
  const div = UNIT_MINUTES[d.unit];
  return { min: Math.round((Number(d.min) || 0) * div), max: Math.round((Number(d.max) || 0) * div) };
}

/** How many `{{n}}` body variables a template expects. */
function templateVariableCount(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const SAMPLE_NAME = 'Antonio';

export function SequenceEditor({
  open,
  onOpenChange,
  sequence,
  tags,
  templates,
  canEdit,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = creating a new one. */
  sequence: FollowupSequence | null;
  tags: Tag[];
  templates: MessageTemplate[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations('Followups.editor');
  const [name, setName] = useState(sequence?.name ?? '');
  const [description, setDescription] = useState(sequence?.description ?? '');
  const [triggerTagId, setTriggerTagId] = useState(sequence?.trigger_tag_id ?? '');
  const [stopTagIds, setStopTagIds] = useState<string[]>(sequence?.stop_tag_ids ?? []);
  const [isActive, setIsActive] = useState(sequence?.is_active ?? false);
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    sequence?.steps.length
      ? sequence.steps.map(toDraft)
      : [blankDraft(0)],
  );
  const [saving, setSaving] = useState(false);
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const sampleVars = useMemo(() => buildVars(SAMPLE_NAME, 'amigo'), []);
  const triggerTag = tags.find((tg) => tg.id === triggerTagId);

  const patchStep = (key: string, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const moveStep = (index: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const insertVariable = (key: string, token: string) => {
    const el = textareas.current[key];
    const current = steps.find((s) => s.key === key)?.message_text ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}{{${token}}}${current.slice(end)}`;
    patchStep(key, { message_text: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length + 4;
      el.setSelectionRange(pos, pos);
    });
  };

  const chooseTemplate = (key: string, value: string) => {
    const tpl = templates.find((x) => `${x.name}::${x.language ?? ''}` === value);
    if (!tpl) return;
    const count = templateVariableCount(tpl.body_text);
    const existing = steps.find((s) => s.key === key)?.template_variables ?? [];
    const variables = Array.from({ length: count }, (_, i) => existing[i] ?? (i === 0 ? '{{nombre}}' : ''));
    patchStep(key, {
      template_name: tpl.name,
      template_language: tpl.language ?? '',
      template_variables: variables,
    });
  };

  // ---- live checks (the server re-validates everything on save) -------
  const ranges = steps.map(draftMinutes);
  const stepErrors: (string | null)[] = steps.map((s, i) => {
    const { min, max } = ranges[i];
    if (min < 1 || max < min) return t('errWait');
    if (i > 0 && min <= ranges[i - 1].max) return t('errOrder', { n: i });
    if (isActive) {
      if (s.message_type === 'text' && !s.message_text.trim()) return t('errEmptyMessage');
      if (s.message_type === 'template' && !s.template_name) return t('errNoTemplate');
    }
    return null;
  });
  const hasBlockingError = !name.trim() || !triggerTagId || stepErrors.some(Boolean);

  const save = async () => {
    if (hasBlockingError) {
      toast.error(!name.trim() ? t('errName') : !triggerTagId ? t('errTrigger') : (stepErrors.find(Boolean) ?? ''));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        trigger_tag_id: triggerTagId,
        stop_tag_ids: stopTagIds,
        is_active: isActive,
        steps: steps.map((s, i) => ({
          position: i,
          delay_min_minutes: ranges[i].min,
          delay_max_minutes: ranges[i].max,
          message_type: s.message_type,
          message_text: s.message_text,
          template_name: s.template_name,
          template_language: s.template_language,
          template_variables: s.template_variables,
        })),
      };
      const res = await fetch(sequence ? `/api/followups/sequences/${sequence.id}` : '/api/followups/sequences', {
        method: sequence ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const tagLabel = (id: string) => tags.find((x) => x.id === id)?.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{sequence ? t('titleEdit') : t('titleNew')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ---- basics ------------------------------------------------ */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fu-name">{t('name')}</Label>
              <Input id="fu-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} disabled={!canEdit || saving} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fu-desc">{t('description')}</Label>
              <Input id="fu-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('descriptionPlaceholder')} disabled={!canEdit || saving} />
            </div>
          </div>

          {/* ---- who / when ---------------------------------------- */}
          <div className="space-y-4 rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Label>{t('trigger')}</Label>
              <p className="text-xs text-muted-foreground">{t('triggerHint')}</p>
              <Select value={triggerTagId} onValueChange={(v) => setTriggerTagId(v ?? '')} disabled={!canEdit || saving}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder={t('triggerPlaceholder')}>{tagLabel(triggerTagId)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tags.map((tg) => (
                    <SelectItem key={tg.id} value={tg.id}>
                      {tg.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {tags.length === 0 && <p className="text-xs text-amber-500">{t('noTags')}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>{t('stopTags')}</Label>
              <p className="text-xs text-muted-foreground">{t('stopTagsHint')}</p>
              <TagMultiSelect
                tags={tags}
                value={stopTagIds}
                onChange={setStopTagIds}
                exclude={triggerTagId ? [triggerTagId] : []}
                disabled={!canEdit || saving}
              />
            </div>
          </div>

          {/* ---- steps ---------------------------------------------- */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="rounded-full border border-border px-2 py-0.5">
                {triggerTag ? t('timelineStart', { tag: triggerTag.name }) : t('timelineStartNoTag')}
              </span>
              {steps.map((s, i) => (
                <span key={s.key} className="inline-flex items-center gap-1.5">
                  <ArrowRight className="h-3 w-3" />
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                      s.message_type === 'template' ? 'border-amber-500/40 text-amber-500' : 'border-primary/40 text-primary',
                    )}
                  >
                    {s.message_type === 'template' ? <FileText className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
                    {ranges[i].min >= 1 && ranges[i].max >= ranges[i].min ? formatDelayRange(ranges[i].min, ranges[i].max) : '?'}
                  </span>
                </span>
              ))}
            </div>

            {steps.map((s, i) => {
              const tpl = templates.find((x) => x.name === s.template_name && (x.language ?? '') === s.template_language);
              const beyondWindow = s.message_type === 'text' && ranges[i].max >= WINDOW_MINUTES;
              const previewBody =
                s.message_type === 'text'
                  ? interpolate(s.message_text, sampleVars)
                  : tpl
                    ? tpl.body_text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) =>
                        interpolate(s.template_variables[Number(n) - 1] ?? '', sampleVars) || `{{${n}}}`,
                      )
                    : '';

              return (
                <div key={s.key} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">{t('stepN', { n: i + 1 })}</p>
                    {canEdit && (
                      <div className="flex items-center gap-0.5">
                        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => moveStep(i, -1)} title={t('moveUp')}>
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} title={t('moveDown')}>
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" disabled={steps.length === 1} onClick={() => setSteps((prev) => prev.filter((x) => x.key !== s.key))} title={t('removeStep')}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* wait */}
                  <div className="space-y-1.5">
                    <Label>{t('wait')}</Label>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{t('waitFrom')}</span>
                      <Input type="number" min={1} value={s.min} onChange={(e) => patchStep(s.key, { min: e.target.value })} className="w-20" disabled={!canEdit || saving} />
                      <span className="text-muted-foreground">{t('waitTo')}</span>
                      <Input type="number" min={1} value={s.max} onChange={(e) => patchStep(s.key, { max: e.target.value })} className="w-20" disabled={!canEdit || saving} />
                      <Select value={s.unit} onValueChange={(v) => patchStep(s.key, { unit: (v ?? 'hours') as Unit })} disabled={!canEdit || saving}>
                        <SelectTrigger className="w-28">
                          <SelectValue>{t(`unit_${s.unit}`)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="minutes">{t('unit_minutes')}</SelectItem>
                          <SelectItem value="hours">{t('unit_hours')}</SelectItem>
                          <SelectItem value="days">{t('unit_days')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('waitHint')}</p>
                  </div>

                  {/* type */}
                  <div className="flex gap-1.5">
                    {(['text', 'template'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        disabled={!canEdit || saving}
                        onClick={() => patchStep(s.key, { message_type: type })}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                          s.message_type === type ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground/30',
                        )}
                      >
                        {type === 'text' ? <MessageSquare className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                        {t(type === 'text' ? 'typeText' : 'typeTemplate')}
                      </button>
                    ))}
                  </div>

                  {/* 24h window badge */}
                  {s.message_type === 'text' ? (
                    beyondWindow ? (
                      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          {t('windowBeyond')}{' '}
                          {canEdit && (
                            <button type="button" className="font-semibold underline" onClick={() => patchStep(s.key, { message_type: 'template' })}>
                              {t('switchToTemplate')}
                            </button>
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{t('windowInside')}</span>
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('templateNote')}</p>
                  )}

                  {/* content */}
                  {s.message_type === 'text' ? (
                    <div className="space-y-1.5">
                      <Textarea
                        ref={(el) => {
                          textareas.current[s.key] = el;
                        }}
                        value={s.message_text}
                        onChange={(e) => patchStep(s.key, { message_text: e.target.value })}
                        rows={4}
                        placeholder={t('messagePlaceholder')}
                        disabled={!canEdit || saving}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">{t('insert')}</span>
                          {FOLLOWUP_VARIABLES.map((v) => (
                            <button
                              key={v}
                              type="button"
                              disabled={!canEdit || saving}
                              onClick={() => insertVariable(s.key, v)}
                              className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
                            >
                              {`{{${v}}}`}
                            </button>
                          ))}
                        </div>
                        <span className={cn('text-xs', s.message_text.length > FOLLOWUP_LIMITS.maxTextLength ? 'text-destructive' : 'text-muted-foreground')}>
                          {s.message_text.length}/{FOLLOWUP_LIMITS.maxTextLength}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <Select value={s.template_name ? `${s.template_name}::${s.template_language}` : ''} onValueChange={(v) => v && chooseTemplate(s.key, v)} disabled={!canEdit || saving}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('templatePlaceholder')}>{s.template_name || undefined}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((tp) => (
                            <SelectItem key={tp.id} value={`${tp.name}::${tp.language ?? ''}`}>
                              {tp.name} · {tp.language ?? '—'} · {tp.category}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {templates.length === 0 && <p className="text-xs text-amber-500">{t('noTemplates')}</p>}

                      {!s.template_name && s.message_text.trim() && (
                        <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5">
                          <p className="text-xs font-medium text-foreground">{t('suggestedTemplate')}</p>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{s.message_text}</p>
                          <p className="mt-1.5 text-xs text-muted-foreground">{t('suggestedTemplateHint')}</p>
                        </div>
                      )}

                      {tpl && tpl.header_type && tpl.header_type !== 'text' && (
                        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{t('mediaHeaderWarning')}</span>
                        </div>
                      )}
                      {tpl && tpl.category === 'Marketing' && <p className="text-xs text-muted-foreground">{t('marketingCost')}</p>}

                      {tpl &&
                        s.template_variables.map((val, vi) => (
                          <div key={vi} className="space-y-1">
                            <Label className="text-xs">{t('variableN', { n: vi + 1 })}</Label>
                            <Input
                              value={val}
                              onChange={(e) =>
                                patchStep(s.key, {
                                  template_variables: s.template_variables.map((x, xi) => (xi === vi ? e.target.value : x)),
                                })
                              }
                              placeholder="{{nombre}}"
                              disabled={!canEdit || saving}
                            />
                          </div>
                        ))}
                    </div>
                  )}

                  {/* preview */}
                  {previewBody && (
                    <div className="rounded-lg bg-muted/40 p-2.5">
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{t('preview', { name: SAMPLE_NAME })}</p>
                      <div className="max-w-sm whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-primary/15 px-3 py-2 text-sm text-foreground">{previewBody}</div>
                    </div>
                  )}

                  {stepErrors[i] && <p className="text-xs text-destructive">{stepErrors[i]}</p>}
                </div>
              );
            })}

            {canEdit && steps.length < FOLLOWUP_LIMITS.maxStepsPerSequence && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => setSteps((prev) => [...prev, blankDraft(draftMinutes(prev[prev.length - 1]).max)])}
              >
                <Plus className="mr-2 h-4 w-4" /> {t('addStep')}
              </Button>
            )}
          </div>

          {/* ---- active -------------------------------------------- */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('active')}</p>
              <p className="text-xs text-muted-foreground">{t('activeHint')}</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} disabled={!canEdit || saving} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          {canEdit && (
            <Button type="button" onClick={save} disabled={saving || hasBlockingError}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
