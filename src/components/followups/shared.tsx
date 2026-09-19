'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { MessageTemplate, Tag } from '@/types';

/** Tags + approved templates for the pickers. RLS scopes both to the account. */
export function useFollowupLookups() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const supabase = createClient();
    const [tagsRes, tplRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('message_templates').select('*').eq('status', 'APPROVED').order('name'),
    ]);
    setTags((tagsRes.data as Tag[] | null) ?? []);
    setTemplates((tplRes.data as MessageTemplate[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return { tags, templates, loading, reload };
}

export function TagChip({
  tag,
  className,
  onRemove,
}: {
  tag: Pick<Tag, 'name' | 'color'> | undefined;
  className?: string;
  onRemove?: () => void;
}) {
  if (!tag) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white',
        className,
      )}
      style={{ backgroundColor: tag.color || '#3b82f6' }}
    >
      {tag.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded-full hover:bg-black/20" aria-label={`Remove ${tag.name}`}>
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * Pick any number of tags by tapping them — every tag in the account is
 * shown as a chip, selected ones are filled. Faster and clearer than a
 * dropdown for the handful of tags a funnel has.
 */
export function TagMultiSelect({
  tags,
  value,
  onChange,
  disabled,
  exclude,
}: {
  tags: Tag[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Tag ids that can't be picked here (e.g. the trigger tag). */
  exclude?: string[];
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags
        .filter((t) => !exclude?.includes(t.id))
        .map((tag) => {
          const selected = value.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(tag.id)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                selected ? 'border-transparent text-white' : 'border-border bg-card text-muted-foreground hover:border-foreground/30',
              )}
              style={selected ? { backgroundColor: tag.color || '#3b82f6' } : undefined}
            >
              {selected && <Check className="h-3 w-3" />}
              {tag.name}
            </button>
          );
        })}
    </div>
  );
}

/** "21h", "45m" — the same compact form the inbox timer uses. */
export function formatRemaining(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h`;
  return `${totalMin}m`;
}

/** "in 3h 10m" / "5m ago" (sign-aware) for scheduling times. */
export function formatRelative(iso: string, now = Date.now()): { future: boolean; text: string } {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  let text: string;
  if (min < 1) text = '<1m';
  else if (min < 60) text = `${min}m`;
  else if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    text = m ? `${h}h ${m}m` : `${h}h`;
  } else {
    const d = Math.floor(min / (24 * 60));
    const h = Math.floor((min % (24 * 60)) / 60);
    text = h ? `${d}d ${h}h` : `${d}d`;
  }
  return { future: diff >= 0, text };
}
