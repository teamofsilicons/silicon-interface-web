"use client";

import * as React from "react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import {
  annotationLabel,
  clearAnnotationSession,
  loadAnnotationSession,
  reindexAnnotations,
  saveAnnotationSession,
} from "@/lib/annotation-session";
import { moveAnnotation } from "@/lib/annotation-coords";
import { generateAnnotatedImage } from "@/lib/annotation-image";
import { generateAnnotatedPdf } from "@/lib/annotation-pdf";
import {
  newAnnotationId,
  type Annotation,
  type Geometry,
  type MarkupDraft,
  type ToolKind,
} from "@/lib/annotation-types";
import { chooseMarkupColor } from "@/lib/annotation-color";
import { uploadMediaBlob } from "@/lib/media-upload";
import { getPdfPageCount, releasePdfDocument, renderPdfPage } from "@/lib/pdf-render";
import type { AnnotationDraft, AnnotationItem } from "@/lib/types";

import { AnnotationsPanel } from "./annotations-panel";
import { ConfirmCloseDialog } from "./confirm-close-dialog";
import { ContinuousPdfStage, type PdfPageRender } from "./continuous-pdf-stage";
import { StudioStage } from "./studio-stage";
import { StudioToolbar } from "./studio-toolbar";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Presigned/download URL of the attachment being annotated. */
  url: string;
  mime: string;
  filename?: string;
  /** The room this annotation set will be attached to. */
  roomId: string;
  /** media_id of the original attachment (the annotation source). */
  sourceMediaId: string;
  /** event_id of the original file message (reply target + silicon reference). */
  sourceEventId?: string;
  /** Stage the flattened annotations as a composer draft (reply-linked to the
   *  file) instead of posting immediately. Falls back to a direct send when
   *  absent. */
  onAttach?: (draft: AnnotationDraft) => void;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

function stepZoom(value: number, direction: 1 | -1): number {
  const next = value + ZOOM_STEP * direction;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
}

/**
 * The annotation studio — a full-bleed modal for marking up an image or PDF.
 *
 * Milestone 2: drawing a markup no longer commits it directly — it becomes a
 * PENDING markup that gates behind a required comment. On submit it commits with
 * a deterministic positional label into the annotations list; the list
 * supports select-to-highlight (jumping to the markup's page), edit-comment, and
 * delete. Autosave (M3) and attach-to-chat (M5) build on this session state.
 */
export function AnnotationStudio({
  open,
  onOpenChange,
  url,
  mime,
  filename,
  roomId,
  sourceMediaId,
  sourceEventId,
  onAttach,
}: Props) {
  const m = (mime || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  const isPdf = m.includes("pdf") || name.endsWith(".pdf");
  const isImage = m.startsWith("image/");
  const label = filename?.trim() || "annotate";

  // --- tool + annotations ---------------------------------------------------
  const [tool, setTool] = React.useState<ToolKind>("pin");
  // Restore any autosaved draft for this (room, attachment) on mount.
  const [annotations, setAnnotations] = React.useState<Annotation[]>(() =>
    loadAnnotationSession(roomId, sourceMediaId),
  );
  // Finished-but-uncommitted markups awaiting one required shared comment.
  const [pending, setPending] = React.useState<MarkupDraft[]>([]);
  const [pendingPage, setPendingPage] = React.useState(0);
  // Existing annotation whose comment is being edited (mutually exclusive with
  // `pending`).
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Shown when closing with unattached annotations (anti-loss guard).
  const [confirmClose, setConfirmClose] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const hasPending = pending.length > 0;
  const promptOpen = hasPending || editingId !== null;

  // Autosave: persist the draft whenever it changes (external-system sync, not
  // React state — so it's the correct use of an effect).
  React.useEffect(() => {
    saveAnnotationSession(roomId, sourceMediaId, annotations);
  }, [annotations, roomId, sourceMediaId]);

  // --- PDF paging + rendering -----------------------------------------------
  const [pageCount, setPageCount] = React.useState(1);
  const [pdfPages, setPdfPages] = React.useState<PdfPageRender[]>([]);
  const [imgDims, setImgDims] = React.useState<{ w: number; h: number } | null>(null);
  const [error, setError] = React.useState(false);
  const clearRenderedMedia = React.useCallback(() => {
    setPdfPages([]);
    setImgDims(null);
    if (isPdf) void releasePdfDocument(url);
  }, [isPdf, url]);

  React.useEffect(() => {
    if (!open || !isPdf) return;
    let alive = true;
    getPdfPageCount(url)
      .then((n) => alive && setPageCount(Math.max(1, n)))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [open, url, isPdf]);

  React.useEffect(() => {
    if (!open || !isPdf) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening a PDF must discard page renders from the previous source
    setPdfPages([]);
    setError(false);
    async function renderAllPages() {
      try {
        const count = await getPdfPageCount(url);
        if (!alive) return;
        for (let i = 1; i <= count; i += 1) {
          const r = await renderPdfPage(url, i);
          if (!alive) return;
          setPdfPages((prev) => [
            ...prev.filter((p) => p.page !== i - 1),
            { page: i - 1, dataUrl: r.dataUrl, pageWidth: r.pageWidth, pageHeight: r.pageHeight },
          ].sort((a, b) => a.page - b.page));
        }
      } catch {
        if (alive) setError(true);
      }
    }
    void renderAllPages();
    return () => {
      alive = false;
    };
  }, [open, url, isPdf]);

  React.useEffect(() => {
    if (!open || !isImage) return;
    let alive = true;
    const im = new Image();
    im.onload = () => alive && setImgDims({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
    im.onerror = () => alive && setError(true);
    im.src = url;
    return () => {
      alive = false;
    };
  }, [open, isImage, url]);

  const imageAnnotations = React.useMemo(
    () => annotations.filter((a) => a.page === 0),
    [annotations],
  );
  const [scrollTargetPage, setScrollTargetPage] = React.useState<number | null>(null);
  const zoomIn = React.useCallback(() => setZoom((z) => stepZoom(z, 1)), []);
  const zoomOut = React.useCallback(() => setZoom((z) => stepZoom(z, -1)), []);
  const resetZoom = React.useCallback(() => setZoom(1), []);

  // Cache authenticated source bytes once. Each sample gets a short-lived blob
  // URL, so repeated pins do not redownload the original and nothing leaks when
  // the picker finishes reading pixels.
  const sourceBlobPromiseRef = React.useRef<{
    mediaId: string;
    promise: Promise<Blob>;
  } | null>(null);
  const readableSamplingSource = React.useCallback(async (fallback: string) => {
    if (fallback.startsWith("data:") || fallback.startsWith("blob:")) {
      return { src: fallback, revoke: null as string | null };
    }
    try {
      if (sourceBlobPromiseRef.current?.mediaId !== sourceMediaId) {
        sourceBlobPromiseRef.current = {
          mediaId: sourceMediaId,
          promise: api.mediaContent(sourceMediaId),
        };
      }
      const objectUrl = URL.createObjectURL(await sourceBlobPromiseRef.current.promise);
      return { src: objectUrl, revoke: objectUrl };
    } catch {
      sourceBlobPromiseRef.current = null;
      return { src: fallback, revoke: null as string | null };
    }
  }, [sourceMediaId]);
  const choosingColorRef = React.useRef(false);

  // Finishing a markup opens the required-comment gate rather than committing.
  const onMarkup = React.useCallback(async (geometry: Geometry, page = 0, imageSrc = url) => {
    if (choosingColorRef.current) return;
    choosingColorRef.current = true;
    setEditingId(null);
    setSelectedId(null); // a fresh markup shifts focus off any prior selection
    setPendingPage(page);
    const readable = await readableSamplingSource(imageSrc);
    try {
      const color = await chooseMarkupColor({ imageSrc: readable.src, geometry });
      setPending([{ geometry, color }]);
    } finally {
      if (readable.revoke) URL.revokeObjectURL(readable.revoke);
      choosingColorRef.current = false;
    }
  }, [readableSamplingSource, url]);

  const goToPage = React.useCallback(
    (page0: number) => {
      if (isPdf) setScrollTargetPage(page0);
    },
    [isPdf],
  );

  const submitComment = React.useCallback(
    (comment: string) => {
      if (pending.length > 0) {
        const first = pending[0];
        const id = newAnnotationId();
        const a: Annotation = {
          id,
          page: pendingPage,
          geometry: first.geometry,
          markups: pending,
          color: first.color,
          refCode: "",
          comment,
        };
        setAnnotations((prev) => [...prev, { ...a, refCode: annotationLabel(prev.length) }]);
        setSelectedId(id);
        setPending([]);
      } else if (editingId) {
        setAnnotations((prev) =>
          prev.map((a) => (a.id === editingId ? { ...a, comment } : a)),
        );
        setEditingId(null);
      }
    },
    [pending, pendingPage, editingId],
  );

  const cancelComment = React.useCallback(() => {
    setPending([]); // discard the pending markup
    setEditingId(null);
  }, []);

  const selectAnnotation = React.useCallback(
    (a: Annotation) => {
      setSelectedId(a.id);
      goToPage(a.page);
    },
    [goToPage],
  );

  const editAnnotation = React.useCallback(
    (a: Annotation) => {
      setSelectedId(a.id);
      goToPage(a.page);
      setPending([]);
      setEditingId(a.id);
    },
    [goToPage],
  );

  const deleteAnnotation = React.useCallback((a: Annotation) => {
    setAnnotations((prev) => reindexAnnotations(prev.filter((x) => x.id !== a.id)));
    setSelectedId((cur) => (cur === a.id ? null : cur));
  }, []);

  const moveExistingAnnotation = React.useCallback((id: string, dx: number, dy: number) => {
    setAnnotations((prev) => prev.map((annotation) => (
      annotation.id === id ? moveAnnotation(annotation, dx, dy) : annotation
    )));
  }, []);

  const undoLast = React.useCallback(() => {
    if (editingId) return;
    if (pending.length > 0) {
      setPending((prev) => {
        const next = prev.slice(0, -1);
        return next;
      });
      return;
    }
    const last = annotations[annotations.length - 1];
    if (last) deleteAnnotation(last);
  }, [annotations, deleteAnnotation, editingId, pending.length]);

  // --- attach to chat -------------------------------------------------------
  const [attaching, setAttaching] = React.useState(false);
  const attach = React.useCallback(async () => {
    if (annotations.length === 0 || attaching) return;
    setAttaching(true);
    let sourceObjectUrl: string | null = null;
    try {
      const baseName = (filename || "attachment").replace(/\.[^.]+$/, "");
      let exportUrl = url;
      try {
        const sourceBlob = await api.mediaContent(sourceMediaId);
        sourceObjectUrl = URL.createObjectURL(sourceBlob);
        exportUrl = sourceObjectUrl;
      } catch {
        // Local/dev media may not have object-store bytes behind Glass. Its
        // original URL remains a valid fallback when it is already readable.
      }
      // Generate ONE annotated file: a PDF (markup + comments burned onto the
      // original via vector overlay) for a PDF source, or an annotated PNG for
      // an image source. Upload it as a normal file.
      const isPdfSource = isPdf;
      const blob = isPdfSource
        ? await generateAnnotatedPdf({ url: exportUrl, annotations, sourceFilename: filename || "attachment" })
        : await generateAnnotatedImage({ url: exportUrl, annotations });
      const annotatedMime = isPdfSource ? "application/pdf" : "image/png";
      const annotatedName = `${baseName}_annotated.${isPdfSource ? "pdf" : "png"}`;
      const annotatedMediaId = await uploadMediaBlob({
        file: blob,
        filename: annotatedName,
        mime: annotatedMime,
        kind: isPdfSource ? "file" : "image",
        roomId,
      });

      const items: AnnotationItem[] = annotations.map((a) => ({
        ref_code: a.refCode,
        page: a.page,
        kind: a.geometry.kind,
        geometry: a.geometry,
        markups: a.markups?.map((m) => ({ geometry: m.geometry, color: m.color })),
        comment: a.comment,
      }));
      const feedbackText = `Feedback:\n${items
        .map((item) => `${item.ref_code}: ${item.comment}`)
        .join("\n")}`;
      const draft: AnnotationDraft = {
        sourceMediaId,
        sourceFilename: filename || "attachment",
        annotatedMediaId,
        annotatedMime,
        annotatedName,
        annotations: items,
        feedbackText,
        ...(sourceEventId ? { sourceEventId } : {}),
      };

      if (onAttach) {
        // Stage as a reply-linked composer draft. Autosave stays intact until
        // the composer actually sends, so an un-sent draft is never lost.
        onAttach(draft);
        setConfirmClose(false);
        clearRenderedMedia();
        onOpenChange(false);
        return;
      }

      // Fallback (no composer wired): post the annotated file directly as a
      // reply to the source message.
      await api.sendEvent(
        roomId,
        {
          type: isPdfSource ? "m.file" : "m.image",
          content: { media_id: annotatedMediaId, mime: annotatedMime, filename: annotatedName },
          ...(sourceEventId ? { reply_to_event_id: sourceEventId } : {}),
        },
      );
      await api.sendEvent(roomId, {
        type: "m.text",
        content: { body: feedbackText },
        ...(sourceEventId ? { reply_to_event_id: sourceEventId } : {}),
      });
      clearAnnotationSession(roomId, sourceMediaId);
      setAnnotations([]);
      setConfirmClose(false);
      clearRenderedMedia();
      onOpenChange(false);
      toast.success("annotations attached to chat");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "couldn't attach annotations");
    } finally {
      if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
      setAttaching(false);
    }
  }, [
    annotations,
    attaching,
    isPdf,
    url,
    filename,
    roomId,
    sourceMediaId,
    sourceEventId,
    onAttach,
    onOpenChange,
    clearRenderedMedia,
  ]);

  // On-document comment bubbles, shared by both stages. Hidden for the
  // annotation being edited (the comment prompt sits at its markup) and muted
  // while any prompt is open.
  const commentLayer = React.useMemo(
    () => ({
      selectedId,
      moveEnabled: tool === "move",
      hideId: editingId,
      muted: promptOpen,
      onSelect: selectAnnotation,
      onEdit: editAnnotation,
      onDelete: deleteAnnotation,
      onMove: moveExistingAnnotation,
    }),
    [
      selectedId,
      tool,
      editingId,
      promptOpen,
      selectAnnotation,
      editAnnotation,
      deleteAnnotation,
      moveExistingAnnotation,
    ],
  );

  const editingAnnotation = editingId ? annotations.find((a) => a.id === editingId) : undefined;
  // The markup the comment popover anchors to: the pending geometry (new) or the
  // annotation being edited.
  const commentAnchor: Geometry | null =
    pending[pending.length - 1]?.geometry ?? editingAnnotation?.geometry ?? null;
  const commentState =
    promptOpen && commentAnchor
      ? {
          promptKey: editingAnnotation ? `edit:${editingAnnotation.id}` : `new:${pendingPage}:${pending.length}`,
          initial: editingAnnotation ? editingAnnotation.comment : "",
          title: editingAnnotation ? editingAnnotation.refCode : "new markup",
          anchor: commentAnchor,
          onSubmit: submitComment,
          onCancel: cancelComment,
        }
      : null;

  // Intercept close attempts (X / Esc / backdrop): if there's unattached work,
  // show the anti-loss guard instead of closing.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      if (promptOpen) return; // ignore while a comment gate is open
      if (annotations.length > 0 || hasPending) {
        setConfirmClose(true);
        return;
      }
      clearRenderedMedia();
      onOpenChange(false);
    },
    [onOpenChange, promptOpen, annotations.length, hasPending, clearRenderedMedia],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex h-[95vh] w-[min(96vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => {
          // The studio is often launched from the media preview dialog. During
          // that handoff, Radix can see focus/pointer changes from the old
          // dialog as an outside interaction and dismiss this one. Keep closing
          // explicit via X/Esc/Attach so a fresh studio cannot disappear.
          e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          // Escape peels back one layer at a time instead of nuking the studio:
          // comment gate → confirm-close guard → (default) close attempt.
          if (promptOpen) {
            e.preventDefault();
            cancelComment();
          } else if (confirmClose) {
            e.preventDefault();
            setConfirmClose(false);
          }
        }}
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
            if (pending.length > 0 || (!promptOpen && annotations.length > 0)) {
              e.preventDefault();
              undoLast();
            }
            return;
          }
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest("textarea,input,[contenteditable='true']")) return;
          const key = e.key.toLowerCase();
          if (!promptOpen) {
            if (key === "d") {
              e.preventDefault();
              setTool("pen");
              return;
            }
            if (key === "r") {
              e.preventDefault();
              setTool("rect");
              return;
            }
            if (key === "p") {
              e.preventDefault();
              setTool("pin");
              return;
            }
            if (key === "m") {
              e.preventDefault();
              setTool("move");
              return;
            }
          }
          if (key === "+" || key === "=") {
            e.preventDefault();
            zoomIn();
          } else if (key === "-" || key === "_") {
            e.preventDefault();
            zoomOut();
          } else if (key === "0") {
            e.preventDefault();
            resetZoom();
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b py-2 pl-4 pr-14">
          <DialogTitle className="truncate text-sm font-medium">{label}</DialogTitle>
        </DialogHeader>

        <StudioToolbar
          tool={tool}
          onToolChange={setTool}
          onUndo={undoLast}
          canUndo={(pending.length > 0 && !editingId) || (annotations.length > 0 && !promptOpen)}
          isPdf={isPdf}
          pageCount={pageCount}
          renderedPageCount={pdfPages.length}
          zoom={zoom}
          canZoomIn={zoom < ZOOM_MAX}
          canZoomOut={zoom > ZOOM_MIN}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomReset={resetZoom}
          onAttach={attach}
          canAttach={annotations.length > 0 && !promptOpen}
          attaching={attaching}
        />

        <div className="flex min-h-0 flex-1">
          {/* Stage area — the page + drawing overlay + comment gate. */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-card p-4">
            {error ? (
              <p className="text-sm text-foreground" role="status">
                couldn&rsquo;t load this attachment for annotation.
              </p>
            ) : !isImage && !isPdf ? (
              <p className="text-sm text-foreground" role="status">
                this type can&rsquo;t be annotated.
              </p>
            ) : isPdf ? (
              pageCount > 0 ? (
                <ContinuousPdfStage
                  pages={pdfPages}
                  pageCount={pageCount}
                  label={label}
                  annotations={annotations}
                  tool={tool}
                  onCommit={(page, geometry, imageSrc) => void onMarkup(geometry, page, imageSrc)}
                  onMove={moveExistingAnnotation}
                  onSelect={selectAnnotation}
                  pending={pending.length > 0 ? { page: pendingPage, markups: pending } : null}
                  highlightId={selectedId}
                  locked={promptOpen}
                  comment={
                    commentState
                      ? {
                          ...commentState,
                          page: editingAnnotation ? editingAnnotation.page : pendingPage,
                        }
                      : null
                  }
                  commentLayer={commentLayer}
                  scrollToPage={scrollTargetPage}
                  zoom={zoom}
                />
              ) : (
                <p className="flex items-center gap-2 text-sm text-foreground" role="status">
                  <CircleNotch className="h-4 w-4 animate-spin" /> preparing…
                </p>
              )
            ) : url && imgDims ? (
              <StudioStage
                displayUrl={url}
                alt={label}
                pageW={imgDims.w}
                pageH={imgDims.h}
                annotations={imageAnnotations}
                tool={tool}
                onCommit={(geometry) => void onMarkup(geometry, 0, url)}
                onMove={moveExistingAnnotation}
                onSelect={selectAnnotation}
                pending={pending}
                highlightId={selectedId}
                locked={promptOpen}
                comment={commentState}
                commentLayer={commentLayer}
                zoom={zoom}
              />
            ) : (
              <p className="flex items-center gap-2 text-sm text-foreground" role="status">
                <CircleNotch className="h-4 w-4 animate-spin" /> preparing image…
              </p>
            )}
          </div>

          <AnnotationsPanel
            annotations={annotations}
            isPdf={isPdf}
            selectedId={selectedId}
            onSelect={selectAnnotation}
            onEdit={editAnnotation}
            onDelete={deleteAnnotation}
          />
        </div>

        {confirmClose && (
          <ConfirmCloseDialog
            count={annotations.length}
            onKeepEditing={() => setConfirmClose(false)}
            onDiscard={() => {
              setConfirmClose(false);
              setAnnotations([]);
              setPending([]);
              setEditingId(null);
              setSelectedId(null);
              clearAnnotationSession(roomId, sourceMediaId);
              clearRenderedMedia();
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
