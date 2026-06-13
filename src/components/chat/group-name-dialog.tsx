"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  /** dialog title, e.g. "New group" or "Rename group" */
  title: string;
  /** prefilled value (for rename) */
  initialValue?: string;
  confirmLabel?: string;
  onOpenChange: (open: boolean) => void;
  /** called with the trimmed name on confirm; dialog closes after */
  onConfirm: (name: string) => void;
}

/** A tiny single-field prompt for creating or renaming a personal chat group. */
export function GroupNameDialog({
  open,
  title,
  initialValue = "",
  confirmLabel = "Save",
  onOpenChange,
  onConfirm,
}: Props) {
  const [value, setValue] = React.useState(initialValue);

  // Reset the field whenever the dialog (re)opens for a new target. This is the
  // "adjust state during render" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // — cheaper than an effect and avoids a cascading re-render.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialValue);
  }

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder="Group name"
          maxLength={60}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
