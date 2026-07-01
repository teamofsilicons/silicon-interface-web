"use client";

import * as React from "react";

import { env } from "@/lib/env";
import { Spinner } from "@/components/ui/spinner";

/**
 * Renders a Quark structure DSL using Glass's hosted Quark engine inside a
 * sandboxed iframe. Shared by the team panel's Structure tab and the Create
 * Team architect step. A cover hides Quark's internal "Loading rough.js…" flash
 * until it signals ``quark:ready`` (or a timeout lifts it).
 */
export function QuarkFrame({ dsl, className }: { dsl: string; className?: string }) {
  const srcDoc = React.useMemo(() => {
    const cssUrl = `${env.apiBase}/static/glass/quark/quark.css`;
    const jsUrl = `${env.apiBase}/static/glass/quark/quark.js`;
    const source = JSON.stringify(dsl).replace(/<\/script/gi, "<\\/script");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${cssUrl}" />
  <style>
    html, body { margin: 0; height: 100%; background: #ede8e0; overflow: hidden; }
    #stage { flex: 1 1 auto; min-height: 0; height: 100vh; width: 100vw; }
    #src, #dl, #png, #pdf { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
  </style>
</head>
<body>
  <textarea id="src" spellcheck="false"></textarea>
  <button id="dl"></button><button id="png"></button><button id="pdf"></button>
  <div class="stage" id="stage">
    <div class="viewport" id="viewport">
      <div class="canvas" id="canvas"><svg class="rough" id="rough" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="zoombadge" id="zoombadge">100%</div>
    <div class="zoomctl">
      <button id="zin" title="Zoom in">+</button>
      <button id="zout" title="Zoom out">-</button>
      <button id="zfit" class="fit" title="Fit to screen">fit</button>
      <button id="zreset" class="fit" title="Reset to 100%">1:1</button>
    </div>
    <div class="err" id="err" style="display:none;"></div>
  </div>
  <script src="${jsUrl}"></script>
  <script>
    (function () {
      var source = ${source};
      function focusMain(attempts) {
        var svg = document.getElementById("rough");
        if (!window.Quark || !svg || !svg.children.length) {
          if (attempts > 0) window.setTimeout(function () { focusMain(attempts - 1); }, 100);
          return;
        }
        if (window.Quark.fitMain) window.Quark.fitMain();
        else if (window.Quark.fit) window.Quark.fit();
        try { window.parent.postMessage({ type: "quark:ready" }, "*"); } catch (e) {}
      }
      function apply() {
        if (window.Quark) {
          window.Quark.setSource(source || "");
          window.setTimeout(function () { focusMain(20); }, 80);
          window.setTimeout(function () { focusMain(1); }, 500);
        } else window.setTimeout(apply, 80);
      }
      apply();
    })();
  </script>
</body>
</html>`;
  }, [dsl]);

  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === iframeRef.current?.contentWindow && e.data?.type === "quark:ready") {
        setReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    const fallback = window.setTimeout(() => setReady(true), 6000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    <div className={className ?? "relative h-[min(70vh,760px)] min-h-[420px] overflow-hidden border bg-card"}>
      <iframe
        ref={iframeRef}
        title="team structure"
        srcDoc={srcDoc}
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin"
      />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center bg-card">
          <Spinner className="text-lg" />
        </div>
      )}
    </div>
  );
}
