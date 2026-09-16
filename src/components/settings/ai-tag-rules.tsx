'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Tags } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';

interface TagRule {
  id: string;
  tag_id: string;
  description: string;
  tags: Pick<Tag, 'id' | 'name' | 'color'> | Pick<Tag, 'id' | 'name' | 'color'>[] | null;
}

function ruleTag(rule: TagRule): Pick<Tag, 'id' | 'name' | 'color'> | null {
  return Array.isArray(rule.tags) ? (rule.tags[0] ?? null) : rule.tags;
}

export function AiTagRulesCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.aiTagRules');
  const [rules, setRules] = useState<TagRule[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, tagsRes] = await Promise.all([
        fetch('/api/ai/tag-rules'),
        createClient().from('tags').select('id, user_id, name, color, created_at').order('name'),
      ]);
      const rulesData = await rulesRes.json();
      if (rulesRes.ok) setRules(rulesData.rules ?? []);
      else toast.error(rulesData.error ?? t('loadFailed'));
      if (!tagsRes.error) setAvailableTags((tagsRes.data ?? []) as Tag[]);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchAll();
  }, [accountId, fetchAll]);

  const openAdd = () => {
    setAdding(true);
    setSelectedTagId('');
    setDescription('');
  };

  const cancelAdd = () => {
    setAdding(false);
    setSelectedTagId('');
    setDescription('');
  };

  const save = async () => {
    if (!selectedTagId || !description.trim()) {
      toast.error(t('tagDescriptionRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/tag-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: selectedTagId, description: description.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        cancelAdd();
        await fetchAll();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/tag-rules/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setRules((r) => r.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  // Tags already configured with a rule are hidden from the picker — one
  // rule per tag (POST upserts, so re-picking one would just edit it, but
  // that's confusing surfaced as "add").
  const configuredTagIds = new Set(rules.map((r) => r.tag_id));
  const pickableTags = availableTags.filter((tg) => !configuredTagIds.has(tg.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tags className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {rules.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground">{t('noRules')}</p>
            )}

            {rules.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {rules.map((rule) => {
                  const tag = ruleTag(rule);
                  return (
                    <li key={rule.id} className="flex items-start justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: tag?.color ?? '#3b82f6' }}
                        >
                          {tag?.name ?? t('unknownTag')}
                        </span>
                        <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(rule.id)}
                          title={t('removeSuccess')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {adding ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label>{t('tagLabel')}</Label>
                  <Select
                    value={selectedTagId}
                    onValueChange={(v) => setSelectedTagId(v ?? '')}
                    disabled={saving}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('tagPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {pickableTags.map((tg) => (
                        <SelectItem key={tg.id} value={tg.id}>
                          {tg.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {pickableTags.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('noTagsLeft')}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tag-rule-desc">{t('descriptionLabel')}</Label>
                  <Textarea
                    id="tag-rule-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('descriptionPlaceholder')}
                    rows={3}
                    disabled={saving}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelAdd} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveRule')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openAdd}
                  disabled={availableTags.length === 0}
                >
                  <Plus className="mr-2 h-4 w-4" /> {t('addRule')}
                </Button>
              )
            )}
            {!loading && availableTags.length === 0 && canEdit && (
              <p className="text-xs text-muted-foreground">{t('noTagsAtAll')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
