import { app } from "../../scripts/app.js";

const STYLE = `
  .nebWrap { display:flex; flex-direction:column; gap:10px; padding:6px 0; }
  .nebCard { border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:12px; background:rgba(0,0,0,0.14); }
  .nebHdr { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .nebTitle { font-weight:850; font-size:13px; letter-spacing:0.2px; opacity:0.95; }
  .nebSub { font-size:12px; opacity:0.7; margin-top:2px; line-height:1.25; }
  .nebRow { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .nebTA, .nebInp {
    border-radius:12px; border:1px solid rgba(255,255,255,0.12);
    background:rgba(0,0,0,0.16); color:inherit; padding:10px 12px; box-sizing:border-box;
  }
  .nebTA { width:100%; min-height:140px; resize:vertical; }
  .nebBtn {
    padding:9px 12px; border-radius:12px;
    border:1px solid rgba(255,255,255,0.14);
    background:rgba(255,255,255,0.06);
    cursor:pointer; color:inherit; font-weight:700;
  }
  .nebBtn:hover { background:rgba(255,255,255,0.10); }
  .nebBtn.primary { background:rgba(80,160,255,0.22); border-color:rgba(80,160,255,0.35); }
  .nebBtn.primary:hover { background:rgba(80,160,255,0.28); }
  .nebPill {
    display:inline-flex; align-items:center; gap:8px;
    padding:6px 10px; border-radius:999px;
    border:1px solid rgba(255,255,255,0.12);
    background:rgba(0,0,0,0.12);
    font-size:12px; opacity:0.95;
  }
  .nebDot { width:8px; height:8px; border-radius:999px; background:rgba(120,220,120,0.9); }
  .nebDot.warn { background:rgba(255,200,80,0.95); }
  .nebDot.err { background:rgba(255,100,100,0.95); }

  .nebSplit { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
  .nebLabel { font-size:12px; opacity:0.75; margin:10px 0 6px; font-weight:800; }
  .nebHelp { font-size:12px; opacity:0.70; line-height:1.3; }
  .nebMono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; opacity:0.95; white-space:pre-wrap; }
`;

function hideWidget(w) {
  if (!w) return;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
}

function markDirty(node) {
  node.setDirtyCanvas(true, true);
  app.graph.setDirtyCanvas(true, true);
}

function splitThinkingPrompt(text) {
  const t = (text || "").trim();

  // <think>...</think>
  const m = t.match(/<think>([\s\S]*?)<\/think>/i);
  if (m) {
    const thinking = (m[1] || "").trim();
    const prompt = t.replace(/<think>[\s\S]*?<\/think>/ig, "").trim();
    return { thinking, prompt };
  }

  // THINKING/REASONING + FINAL/PROMPT
  const m2 = t.match(/(THINKING:|REASONING:)([\s\S]*?)(FINAL:|PROMPT:)([\s\S]*)$/i);
  if (m2) {
    return { thinking: (m2[2] || "").trim(), prompt: (m2[4] || "").trim() };
  }

  // FINAL PROMPT / PROMPT
  const m3 = t.match(/(FINAL PROMPT:|PROMPT:)\s*([\s\S]*)$/i);
  if (m3) {
    const prompt = (m3[2] || "").trim();
    const before = t.slice(0, t.toLowerCase().indexOf(m3[1].toLowerCase())).trim();
    return { thinking: before, prompt };
  }

  return { thinking: "", prompt: t };
}

app.registerExtension({
  name: "nebula.qwen.rich_ui.v2",

  async nodeCreated(node) {
    const cls = node.comfyClass;

    const isEncodeSFW = cls === "NebulaTextEncodeQwenImageEditPlusSFW";
    const isEncodeNSFW = cls === "NebulaTextEncodeQwenImageEditPlusNSFW";
    const isOutput = cls === "NebulaTextEncodeQwenOutput";

    if (!isEncodeSFW && !isEncodeNSFW && !isOutput) return;

    const wPrompt = node.widgets?.find(w => w.name === "prompt");
    if (!wPrompt) return;

    hideWidget(wPrompt);

    const style = document.createElement("style");
    style.textContent = STYLE;

    const wrap = document.createElement("div");
    wrap.className = "nebWrap";
    wrap.appendChild(style);

    const card = document.createElement("div");
    card.className = "nebCard";

    const hdr = document.createElement("div");
    hdr.className = "nebHdr";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "nebTitle";

    if (isEncodeNSFW) title.textContent = "Nebula Qwen Text Encoder (NSFW Allowed)";
    else if (isEncodeSFW) title.textContent = "Nebula Qwen Text Encoder (SFW)";
    else title.textContent = "Nebula Qwen Output (Thinking + Prompt + Conditioning)";

    const sub = document.createElement("div");
    sub.className = "nebSub";
    sub.textContent = isOutput
      ? "Splits <think>…</think> from your input, outputs Thinking + final Prompt, and encodes the final Prompt into conditioning (NSFW-allowed template)."
      : "Image-aware prompt encoding for Qwen2.5-VL Instruct templates. Attach up to 3 images + optional VAE for reference latents.";

    left.appendChild(title);
    left.appendChild(sub);

    const pill = document.createElement("div");
    pill.className = "nebPill";
    pill.innerHTML = `<span class="nebDot"></span><span>Ready</span>`;

    hdr.appendChild(left);
    hdr.appendChild(pill);

    const setStatus = (text, kind = "ok") => {
      const dot = pill.querySelector(".nebDot");
      const txt = pill.querySelector("span:last-child");
      dot.classList.remove("warn", "err");
      if (kind === "warn") dot.classList.add("warn");
      if (kind === "err") dot.classList.add("err");
      txt.textContent = text;
    };

    const help = document.createElement("div");
    help.className = "nebHelp";
    help.innerHTML = isOutput
      ? `
        <div class="nebLabel">How it works</div>
        <div>• If your text includes <span class="nebMono">&lt;think&gt;...&lt;/think&gt;</span>, it will be split into outputs.</div>
        <div>• Only the final Prompt is used for conditioning encoding.</div>
      `
      : `
        <div class="nebLabel">Tips</div>
        <div>• Be explicit (pose, camera, lighting, identity locks).</div>
        <div>• You can include <span class="nebMono">&lt;think&gt;...&lt;/think&gt;</span> in the prompt text if you want to preserve reasoning separately.</div>
      `;

    const promptLabel = document.createElement("div");
    promptLabel.className = "nebLabel";
    promptLabel.textContent = isOutput ? "LLM Output / Prompt Input" : "Prompt";

    const ta = document.createElement("textarea");
    ta.className = "nebTA";
    ta.placeholder = isOutput
      ? "Paste LLM output here… (optionally with <think>...</think>)"
      : "Write the instruction prompt here…";
    ta.value = wPrompt.value || "";

    ta.addEventListener("input", () => {
      wPrompt.value = ta.value;
      markDirty(node);
      if (isOutput) renderPreview();
    });

    const btnRow = document.createElement("div");
    btnRow.className = "nebRow";

    const btnClear = document.createElement("button");
    btnClear.className = "nebBtn";
    btnClear.textContent = "Clear";
    btnClear.onclick = () => {
      ta.value = "";
      wPrompt.value = "";
      markDirty(node);
      if (isOutput) renderPreview();
      setStatus("Cleared", "warn");
      setTimeout(() => setStatus("Ready", "ok"), 700);
    };

    const btnCopy = document.createElement("button");
    btnCopy.className = "nebBtn primary";
    btnCopy.textContent = "Copy";
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(ta.value || "");
        setStatus("Copied", "ok");
      } catch {
        setStatus("Copy failed", "err");
      }
    };

    btnRow.appendChild(btnClear);
    btnRow.appendChild(btnCopy);

    // Output node preview panel
    let previewWrap = null;
    let thinkingBox = null;
    let promptBox = null;

    function renderPreview() {
      if (!isOutput) return;
      const { thinking, prompt } = splitThinkingPrompt(ta.value || "");
      thinkingBox.textContent = thinking || "(empty)";
      promptBox.textContent = prompt || "(empty)";
    }

    card.appendChild(hdr);
    card.appendChild(help);
    card.appendChild(promptLabel);
    card.appendChild(ta);
    card.appendChild(btnRow);

    if (isOutput) {
      previewWrap = document.createElement("div");
      previewWrap.className = "nebCard";
      previewWrap.style.marginTop = "10px";

      const previewTitle = document.createElement("div");
      previewTitle.className = "nebTitle";
      previewTitle.textContent = "Live Preview (what will be output)";

      const split = document.createElement("div");
      split.className = "nebSplit";

      const col1 = document.createElement("div");
      const col2 = document.createElement("div");

      const l1 = document.createElement("div");
      l1.className = "nebLabel";
      l1.textContent = "Thinking";

      thinkingBox = document.createElement("div");
      thinkingBox.className = "nebMono";
      thinkingBox.style.minHeight = "120px";
      thinkingBox.style.border = "1px solid rgba(255,255,255,0.12)";
      thinkingBox.style.borderRadius = "12px";
      thinkingBox.style.padding = "10px 12px";
      thinkingBox.style.background = "rgba(0,0,0,0.16)";

      const l2 = document.createElement("div");
      l2.className = "nebLabel";
      l2.textContent = "Final Prompt (used for conditioning)";

      promptBox = document.createElement("div");
      promptBox.className = "nebMono";
      promptBox.style.minHeight = "120px";
      promptBox.style.border = "1px solid rgba(255,255,255,0.12)";
      promptBox.style.borderRadius = "12px";
      promptBox.style.padding = "10px 12px";
      promptBox.style.background = "rgba(0,0,0,0.16)";

      col1.appendChild(l1);
      col1.appendChild(thinkingBox);

      col2.appendChild(l2);
      col2.appendChild(promptBox);

      split.appendChild(col1);
      split.appendChild(col2);

      previewWrap.appendChild(previewTitle);
      previewWrap.appendChild(split);

      wrap.appendChild(card);
      wrap.appendChild(previewWrap);

      node.addDOMWidget("nebula_qwen_output_ui", "div", wrap, { serialize: false });

      renderPreview();
      return;
    }

    wrap.appendChild(card);
    node.addDOMWidget("nebula_qwen_encode_ui", "div", wrap, { serialize: false });
  }
});
