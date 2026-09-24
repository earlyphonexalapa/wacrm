'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  BookOpen,
  ImagePlus,
  FileText,
  Paperclip,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';

/** Mirrors MAX_KNOWLEDGE_MEDIA_ITEMS in src/lib/ai/knowledge.ts. */
const MAX_MEDIA_ITEMS = 5;

interface MediaItem {
  url: string;
  type: string;
}

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
  media_count?: number;
}

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

function isImage(type: string): boolean {
  return type.startsWith('image/');
}

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  // Comma-separated words; the files are sent only when the customer writes one.
  const [mediaTriggers, setMediaTriggers] = useState('');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations('Settings.aiKnowledge');

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  const openNew = () => {
    setEditing('new');
    setTitle('');
    setContent('');
    setMediaItems([]);
    setMediaTriggers('');
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      setEditing(id);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
      setMediaItems(Array.isArray(data.media) ? data.media : []);
      setMediaTriggers(Array.isArray(data.media_triggers) ? data.media_triggers.join(', ') : '');
    } catch {
      toast.error(t('openFailed'));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setMediaItems([]);
    setMediaTriggers('');
  };

  const pickFiles = () => fileInputRef.current?.click();

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file(s) later
    if (files.length === 0) return;

    const remaining = MAX_MEDIA_ITEMS - mediaItems.length;
    if (remaining <= 0) {
      toast.error(t('maxItemsReached', { max: MAX_MEDIA_ITEMS }));
      return;
    }
    const toUpload = files.slice(0, remaining);
    if (files.length > toUpload.length) {
      toast.warning(t('maxItemsTrimmed', { max: MAX_MEDIA_ITEMS }));
    }

    setUploadingMedia(true);
    try {
      for (const file of toUpload) {
        const image = file.type.startsWith('image/');
        const pdf = file.type === 'application/pdf';
        if (!image && !pdf) {
          toast.error(t('fileTypeInvalid', { name: file.name }));
          continue;
        }
        const limit = image
          ? MEDIA_MAX_BYTES_BY_KIND.image
          : MEDIA_MAX_BYTES_BY_KIND.document;
        if (file.size > limit) {
          toast.error(t('fileTooLarge', { name: file.name }));
          continue;
        }
        try {
          const { publicUrl } = await uploadAccountMedia('chat-media', file);
          setMediaItems((prev) => [...prev, { url: publicUrl, type: file.type }]);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t('fileUploadFailed'));
        }
      }
    } finally {
      setUploadingMedia(false);
    }
  };

  const removeMediaItem = (index: number) => {
    setMediaItems((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error(t('titleContentRequired'));
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            content: content.trim(),
            media: mediaItems,
            media_triggers: mediaTriggers
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean),
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        // A 200 with `warning` means saved but indexing degraded.
        if (data.warning) toast.warning(data.warning);
        else toast.success(isNew ? t('saveSuccessNew') : t('saveSuccessUpdate'));
        cancelEdit();
        await fetchDocs();
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
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(t('reindexSuccess', { count: data.reindexed }));
      } else {
        toast.error(data.error ?? t('reindexFailed'));
      }
    } catch {
      toast.error(t('reindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey ? t('semanticSearchOn') : t('keywordSearchOn')
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">
                {t('noDocs')}
              </p>
            )}

            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 truncate text-sm text-foreground">
                      {Boolean(doc.media_count) && (
                        <Paperclip
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-label={t('hasAttachments', { count: doc.media_count ?? 0 })}
                        />
                      )}
                      {doc.title}
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => void openEdit(doc.id)}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(doc.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title">{t('editDocTitle')}</Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('editDocTitlePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-content">{t('editDocContent')}</Label>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('editDocContentPlaceholder')}
                    rows={8}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('editDocMedia')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('editDocMediaHint', { max: MAX_MEDIA_ITEMS })}
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    className="hidden"
                    onChange={(e) => void onFilesSelected(e)}
                  />

                  {mediaItems.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {mediaItems.map((item, i) => (
                        <div key={i} className="relative">
                          {isImage(item.type) ? (
                            /* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local asset */
                            <img
                              src={item.url}
                              alt=""
                              className="h-20 w-20 rounded-md border border-border object-cover"
                            />
                          ) : (
                            <div className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted px-1 text-center">
                              <FileText className="h-6 w-6 text-muted-foreground" />
                              <span className="w-full truncate text-[10px] text-muted-foreground">
                                PDF
                              </span>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => removeMediaItem(i)}
                            disabled={saving}
                            className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-destructive-foreground"
                            title={t('removeItem')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {mediaItems.length < MAX_MEDIA_ITEMS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={pickFiles}
                      disabled={saving || uploadingMedia}
                    >
                      {uploadingMedia ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ImagePlus className="mr-2 h-4 w-4" />
                      )}
                      {t('addFiles')} ({mediaItems.length}/{MAX_MEDIA_ITEMS})
                    </Button>
                  )}

                  {mediaItems.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <Label htmlFor="kb-media-triggers">{t('mediaTriggersLabel')}</Label>
                      <Input
                        id="kb-media-triggers"
                        value={mediaTriggers}
                        onChange={(e) => setMediaTriggers(e.target.value)}
                        placeholder={t('mediaTriggersPlaceholder')}
                        disabled={saving}
                      />
                      <p className="text-xs text-muted-foreground">{t('mediaTriggersHint')}</p>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving || uploadingMedia}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={openNew}>
                    <Plus className="mr-2 h-4 w-4" /> {t('addDoc')}
                  </Button>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reindex}
                      disabled={reindexing}
                      title={t('reindexTooltip')}
                    >
                      {reindexing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {t('reindex')}
                    </Button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
