import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useBranding } from '@/state/branding';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';

/** Matches the server's limit, so an oversized file is rejected before upload. */
const MAX_BYTES = 512 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export function LogoUploader() {
  const { organizationName, logoUrl, refresh } = useBranding();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error(`That image is ${Math.round(file.size / 1024)}KB. The limit is ${MAX_BYTES / 1024}KB.`);
      return;
    }

    setBusy(true);
    try {
      await api.branding.uploadLogo(file);
      await refresh();
      toast.success('Logo updated.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not upload that logo.');
    } finally {
      setBusy(false);
      // Clear the input so picking the same file again still fires a change.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function onRemove() {
    setBusy(true);
    try {
      await api.branding.removeLogo();
      await refresh();
      toast.success('Logo removed.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the logo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field
      label="Logo"
      hint="Shown in the sidebar, on the sign-in screen and as the browser tab icon. PNG, JPEG, GIF or WebP, up to 512KB."
    >
      <div className="flex items-center gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border surface-2">
          {logoUrl ? (
            <img src={logoUrl} alt={`${organizationName} logo`} className="size-full object-contain" />
          ) : (
            <ImageUp className="size-4 text-[var(--fg-subtle)]" aria-hidden />
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy} onClick={() => inputRef.current?.click()}>
            {logoUrl ? 'Replace' : 'Upload'}
          </Button>
          {logoUrl && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
              <Trash2 className="size-3.5" aria-hidden />
              Remove
            </Button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
      </div>
    </Field>
  );
}
