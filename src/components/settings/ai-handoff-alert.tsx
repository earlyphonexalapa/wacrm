'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, BellRing, Loader2, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageTemplate } from '@/types';

const VARIABLE_TOKENS = ['{{nombre}}', '{{telefono}}', '{{resumen}}', '{{enlace}}'];
const DEFAULT_VARIABLES = ['{{nombre}}', '{{telefono}}', '{{resumen}}'];

// Suggested wording for the Meta template (kept out of the message catalogue: ICU would read {{1}} as syntax).
const SUGGESTED_BODY =
  'Alerta EarlyAcademy: el lead {{1}} ({{2}}) necesita atención humana. Resumen: {{3}}. Ábrelo en WaCRM para tomar el chat.';

/** How many `{{n}}` body variables a template expects. */
function variableCount(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function AiHandoffAlertCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Settings.aiHandoffAlert');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);

  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateLanguage, setTemplateLanguage] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  // What's stored on the server, so "Send a test" can warn about unsaved edits.
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, tplRes] = await Promise.all([
        fetch('/api/ai/handoff-alert', { cache: 'no-store' }),
        createClient().from('message_templates').select('*').eq('status', 'APPROVED').order('name'),
      ]);
      const data = await res.json();
      if (res.ok) {
        const s = data.settings;
        setEnabled(Boolean(s.enabled));
        setPhone(s.phone ?? '');
        setTemplateName(s.templateName ?? '');
        setTemplateLanguage(s.templateLanguage ?? '');
        setVariables(s.templateVariables ?? []);
      } else {
        toast.error(data.error ?? t('loadFailed'));
      }
      setTemplates((tplRes.data as MessageTemplate[] | null) ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };

  const chooseTemplate = (value: string) => {
    const [name, lang] = value.split('::');
    const tpl = templates.find((x) => x.name === name && (x.language ?? '') === lang);
    const count = tpl ? variableCount(tpl.body_text) : 0;
    setTemplateName(name);
    setTemplateLanguage(lang);
    setVariables(Array.from({ length: count }, (_, i) => variables[i] || DEFAULT_VARIABLES[i] || ''));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/handoff-alert', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          phone,
          template_name: templateName || null,
          template_language: templateLanguage || null,
          template_variables: variables,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setDirty(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/handoff-alert/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('testFailed'));
      } else if (data.status === 'sent') {
        toast.success(data.via === 'template' ? t('testSentTemplate') : t('testSentText'));
      } else if (data.status === 'skipped') {
        toast.error(t(`skipped_${data.reason}` as never));
      } else {
        toast.error(t('testError', { error: data.error ?? '' }));
      }
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const tpl = templates.find((x) => x.name === templateName && (x.language ?? '') === templateLanguage);
  const mediaHeader = Boolean(tpl?.header_type && tpl.header_type !== 'text');
  const disabled = !canEdit || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enable')}</p>
                <p className="text-xs text-muted-foreground">{t('enableDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={edit(setEnabled)} disabled={disabled} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ha-phone">{t('phone')}</Label>
              <Input
                id="ha-phone"
                value={phone}
                onChange={(e) => edit(setPhone)(e.target.value)}
                placeholder="+5215512345678"
                className="w-full sm:w-72"
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('phoneHint')}</p>
            </div>

            <div className="space-y-2.5 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('templateTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('templateDesc')}</p>
              </div>

              <Select
                value={templateName ? `${templateName}::${templateLanguage}` : ''}
                onValueChange={(v) => v && chooseTemplate(v)}
                disabled={disabled}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('templatePlaceholder')}>{templateName || undefined}</SelectValue>
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

              {!templateName && (
                <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5">
                  <p className="text-xs font-medium text-foreground">{t('suggestedTitle')}</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{SUGGESTED_BODY}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('suggestedHint')}</p>
                </div>
              )}

              {mediaHeader && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('mediaHeaderWarning')}</span>
                </div>
              )}

              {tpl && variables.length > 0 && (
                <div className="space-y-2">
                  {variables.map((val, i) => (
                    <div key={i} className="space-y-1">
                      <Label className="text-xs">{t('variableN', { n: i + 1 })}</Label>
                      <Input
                        value={val}
                        onChange={(e) => edit(setVariables)(variables.map((x, xi) => (xi === i ? e.target.value : x)))}
                        placeholder="{{nombre}}"
                        disabled={disabled}
                      />
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{t('availableVariables')}</span>
                    {VARIABLE_TOKENS.map((v) => (
                      <code key={v} className="rounded bg-muted px-1.5 py-0.5">
                        {v}
                      </code>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('variablesHint')}</p>
                </div>
              )}
            </div>

            {canEdit && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" onClick={sendTest} disabled={testing || saving || dirty || !phone.trim()} title={dirty ? t('saveFirst') : undefined}>
                  {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {t('sendTest')}
                </Button>
                <Button onClick={save} disabled={saving || !dirty}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
