import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { SpaceSettingOverrides } from "./SpaceSettingOverrides";
import type { SettingsSpace } from "./shell/dialogs";
import { DeleteSpaceDialog } from "./shell/dialogs";

/** One space's page: its name, the account settings it customizes, and deletion for its owner. */
export function SpaceSettingsPanel({
  space,
  onRename,
  onDelete,
  onClose,
  onBusyChange,
  memberSettingsLocked = false,
}: {
  space: SettingsSpace;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** A locked deployment's member runs on the owner's models and voice in every Space. */
  memberSettingsLocked?: boolean;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [draft, setDraft] = useState(space.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [overridesBusy, setOverridesBusy] = useState(false);
  // A rename in flight holds the dialog open, so a failure is shown instead of lost on leaving.
  const busy = pending || overridesBusy;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  async function save() {
    const trimmed = draft.trim();
    if (pending) return;
    // An empty or unchanged name keeps the current one without a request.
    if (!trimmed || trimmed === space.name) {
      setDraft(space.name);
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(trimmed);
      setDraft(trimmed);
    } catch (err) {
      setError(
        err instanceof Error && err.message.trim() ? err.message : t`Could not rename space`,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8" data-testid="space-settings">
      {space.canRename ? (
        <SettingsGroup>
          <SettingsRow
            label={
              <label htmlFor={nameId}>
                <Trans>Name</Trans>
              </label>
            }
            control={
              <Input
                id={nameId}
                className="w-56"
                maxLength={60}
                value={draft}
                disabled={pending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                  // Enter that confirms an IME composition is not a commit.
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setDraft(space.name);
                    setError(null);
                  }
                }}
              />
            }
          >
            {error ? (
              <p role="alert" className="pt-2 text-[12.5px] text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="submit" className="rounded-full" disabled={pending || !trimmed}>
                <Trans>Save</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="rounded-full"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <SettingsRow
            label={<p className="break-words">{space.name}</p>}
            control={
              space.canRename ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  aria-label={t`Rename space`}
                  onClick={() => {
                    setError(null);
                    setDraft(space.name);
                  }}
                >
                  <Trans>Edit</Trans>
                </Button>
              ) : null
            }
          />
        )}
      </SettingsGroup>
      <SpaceSettingOverrides
        onClose={onClose}
        onBusyChange={onBusyChange}
        memberSettingsLocked={memberSettingsLocked}
      />
      {space.canDelete ? (
        <Button
          variant="destructive"
          className="rounded-full"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trans>Delete space</Trans>
        </Button>
      ) : null}
      {confirmingDelete ? (
        <DeleteSpaceDialog
          space={space}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onDelete}
        />
      ) : null}
    </div>
  );
}
