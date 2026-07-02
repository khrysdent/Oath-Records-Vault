import React, { useState, useRef, useMemo } from "react";
import {
  Upload, FileText, Loader, Check, AlertTriangle, ChevronDown, ChevronUp,
  Trash2, Code, X, Clock, RotateCcw, Search,
  LayoutGrid, ListOrdered, Stethoscope, ShieldCheck,
  Layers, Download, MapPin,
} from "lucide-react";

/* ============================ Defaults ============================ */
const DEFAULT_PROMPT = `You are reading a real medical document for a veteran health-records consolidation tool. Read the attached document carefully and extract structured clinical information.

Many documents cover a SINGLE visit or encounter. Some documents — like a longitudinal chart export, a problem list, or a multi-year summary — cover MULTIPLE separate dated events in one file. Handle both correctly: do not collapse a multi-date document down to just one date.

Return ONLY valid JSON (no markdown fences, no commentary) matching this exact shape:

{
  "patient_name": "string — the patient's full name as it appears on the document, else null",
  "patient_branch": "string — military branch if mentioned (e.g. 'U.S. Army', 'U.S. Navy'), else null",
  "patient_era": "string — service era or period if mentioned or inferable from dates (e.g. 'Vietnam Era', 'OIF/OEF Era'), else null",
  "document_type": "string — e.g. 'Consult note', 'Discharge summary', 'Lab report', 'Imaging report', 'Prescription record', 'Multi-visit chart export'",
  "visit_setting": "string — the KIND of appointment, from a veteran's point of view: 'Primary Care Visit', 'Specialist Visit', 'Lab Work', 'Imaging', 'ER Visit', 'Mental Health Visit', 'Dental Visit', 'Pharmacy', or similar. This answers 'where did I go' — not the clinical document type. Else null.",
  "what_happened": "string — classify this visit into ONE of these categories: 'Preventive Care', 'Follow-up', 'Acute Care', 'Mental Health', 'Specialist Consultation', 'Lab / Imaging', 'Chronic Disease Management', 'Surgery / Procedure'. Choose the best fit. Else null.",
  "date": "string — if this document is ABOUT ONE visit/encounter, its date in YYYY-MM-DD if determinable. If this document spans MULTIPLE distinct dated events, set this to null and use the events array instead.",
  "provider": "string — clinician or facility name if present and this is a single-visit document, else null",
  "facility": "string — hospital/clinic/system name if present, else null",
  "facility_location": "string — the place this care happened: a military installation if named (e.g. 'Fort Bragg', 'Camp Pendleton', 'Fort Stewart'), otherwise a city/state (e.g. 'Killeen, TX'), else null. This should be a clean, consistent place name suitable for grouping visits by location — not a full street address. Base this ONLY on what this specific document says; do not assume it matches any other document.",
  "events": [
    {
      "date": "string — YYYY-MM-DD if determinable, otherwise best available format. REQUIRED for each event.",
      "label": "string — short description of what happened on this date, e.g. 'Initial consult', 'Follow-up visit', 'Lab result recorded'",
      "visit_setting": "string or null — same meaning as the top-level visit_setting field",
      "what_happened": "string or null — same meaning as the top-level what_happened field",
      "provider": "string or null",
      "facility": "string or null",
      "facility_location": "string or null — same rules as the top-level facility_location field",
      "diagnoses": [ { "description": "string", "icd10cm": "code or null", "confidence": "high | medium | low" } ],
      "notes": "string or null — anything specific to this dated event"
    }
  ],
  "diagnoses": [
    { "description": "plain-language description", "icd10cm": "code if you can confidently identify one, else null", "confidence": "high | medium | low" }
  ],
  "procedures": [ { "description": "string", "date": "string or null" } ],
  "medications": [ { "name": "string", "dose": "string or null", "instructions": "string or null" } ],
  "plain_summary": "2-3 sentence plain-language summary a non-clinical reader (the veteran) could understand",
  "flags": [ "anything notable, ambiguous, or that seems important for continuity of care, e.g. allergy mentioned, conflicting dates, illegible section" ],
  "extraction_notes": "anything you were unsure about or could not read confidently"
}

Rules:
- If a field has no data, use null or an empty array — never fabricate.
- For ICD-10-CM codes, only include one if you're genuinely confident; otherwise set icd10cm to null and confidence accordingly. Do not guess codes.
- For patient_name, patient_branch, and patient_era: only fill these in if they genuinely appear in or are clearly inferable from the document. Do not guess a name or branch that isn't there.
- For facility_location: read THIS document's own address, facility name, or letterhead independently — every document should be evaluated on its own, never assumed to share a location with any other document you may have processed before. Only normalize the SPELLING of a name you already identified (e.g. "Ft. Bragg" and "FORT BRAGG, NC" both become "Fort Bragg") — never infer a location that isn't actually stated or clearly implied by the facility name/address on this specific document. If this document doesn't state or imply a location, use null rather than guessing one from context.
- CRITICAL — distinguishing dates: a document often contains several DIFFERENT kinds of dates (date of birth, enlistment date, the date the document was printed/generated, and one or more actual visit/service dates). Do not default to whichever date appears first or most prominently — read carefully and use only genuine clinical encounter dates, never a date of birth, for "date" or for any event's "date".
- If the document describes ONE visit/encounter only: fill in the top-level "date", "provider", "diagnoses" etc. as usual, and leave "events" as an empty array.
- If the document describes MULTIPLE visits/encounters at different dates (e.g. a chart history, a multi-year summary, a list of past appointments): set the top-level "date" to null, and instead populate "events" with one entry per distinct date found, each with its own diagnoses if applicable. Still fill in document-level fields (patient_name, patient_branch, etc.) once at the top level — those don't repeat per event.
- KEEP TEXT FIELDS BRIEF, especially on documents with many events: "label" should be a few words, not a sentence; "notes" and "plain_summary" should be one short sentence, not a paragraph. On a document with many dated visits, prioritize getting every date, diagnosis, and code captured accurately over writing long descriptions — terse and complete beats detailed and truncated.
- DISTINGUISH visit_setting from what_happened — they answer different questions. "visit_setting" is WHERE you went (Primary Care Visit, Specialist Visit, Lab Work, Imaging, ER Visit, Mental Health Visit, Dental Visit, Pharmacy). "what_happened" is WHY you went — pick the single best category from: 'Preventive Care', 'Follow-up', 'Acute Care', 'Mental Health', 'Specialist Consultation', 'Lab / Imaging', 'Chronic Disease Management', 'Surgery / Procedure'. These are fixed categories, not freeform text.
- If a single document has an unusually large number of distinct visits (more than ~15), still capture every date and its diagnoses, but keep "label" to 2-4 words and omit "notes" (use null) for most events so the response stays complete rather than cutting off.
- Be conservative and accurate over complete. Missing data is better than wrong data.`;

// Named phases for the progress bar. The API itself returns a single response (no live
// progress signal), so this advances on a timer to reflect roughly what's happening,
// then holds at the last "in-flight" stage until the real response actually arrives —
// it never claims 100% before the result is in.
const BASE_STAGES = [
  { label: "Reading document", pct: 18 },
  { label: "Identifying patient & dates", pct: 42 },
  { label: "Extracting diagnoses & codes", pct: 68 },
];
// The final stage label changes based on whether this is the first record or an addition.
function getStages(isFirst) {
  return [...BASE_STAGES, { label: isFirst ? "Building your summary" : "Adding to your summary", pct: 88 }];
}
// EXTRACT_STAGES kept for length references; actual labels come from getStages().
const EXTRACT_STAGES = [...BASE_STAGES, { label: "Building your summary", pct: 88 }];
const STAGE_INTERVAL_MS = 1100;

const FIELD_HELP = {
  document_type: "What kind of document this is",
  visit_setting: "The kind of appointment — where the veteran went",
  what_happened: "What this visit was actually for, in plain language",
  date: "The clinical date of service — used for chronological ordering",
  provider: "Individual clinician, if named",
  facility: "Hospital, clinic, or health system",
  facility_location: "Installation, city, or place this care happened",
  diagnoses: "Conditions identified, with ICD-10-CM where confident",
  procedures: "Anything done to the patient",
  medications: "Drugs prescribed or administered",
  plain_summary: "Plain-language version for the veteran to read",
  flags: "Anything worth a human's attention",
  extraction_notes: "Claude's own notes on uncertainty",
};

/* ============================ Size limits & helpers ============================ */
const MAX_PDF_BYTES = 32 * 1024 * 1024;       // conservative ceiling for base64-encoded PDFs
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;      // images get auto-downscaled above this
const IMAGE_MAX_DIMENSION = 2200;             // px, long edge — plenty for OCR-quality reading

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function humanSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Downscales + recompresses an oversized image in-browser before it ever leaves the page.
function downscaleImage(file, maxDim = IMAGE_MAX_DIMENSION, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        blob => {
          if (!blob) return reject(new Error("Could not process image"));
          const r = new FileReader();
          r.onload = () => resolve({ base64: r.result.split(",")[1], mediaType: "image/jpeg", bytes: blob.size });
          r.onerror = reject;
          r.readAsDataURL(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not load image for resizing")); };
    img.src = url;
  });
}

// ---- Two-pass extraction for unusually dense documents ----
// Pass 1: ask only for a lightweight index (document-level fields + a bare list of
// dates/labels). This is cheap and should always complete even on a very dense document.
// Pass 2: re-send the SAME document once per small batch of dates from the index, asking
// only for full detail on those specific dates. Each chunk is small enough to finish
// comfortably. Results are merged back into the same shape the rest of the app expects.
// All of this happens automatically — the person uploading never sees or does any of it.

// ---- Dense document fallback (artifact-only — billed to Claude.ai, not your API key) ----
// When a single pass can't fit the whole document, we run two lighter passes instead
// of failing outright: an index pass to find every date, then small detail batches.
// This stays controlled — a 40-visit document costs about 11 total calls, not unbounded.

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildIndexPrompt() {
  return `You are reading a real medical document for a veteran health-records consolidation tool. This document may be dense, spanning many visits.

For this pass, do NOT extract full detail. Just build a lightweight index.

Return ONLY valid JSON (no markdown fences, no commentary) matching this shape:
{
  "patient_name": "string or null",
  "patient_branch": "string or null",
  "patient_era": "string or null",
  "document_type": "string",
  "facility_location": "string or null",
  "dates": [ { "date": "YYYY-MM-DD or best available", "label": "3-6 words max" } ]
}

Rules:
- List EVERY distinct dated clinical encounter. Do not skip any.
- Never use date of birth, enlistment date, or document print date.
- Keep labels extremely short (3-6 words max).`;
}

function buildDetailPrompt(dateBatch) {
  const dateList = dateBatch.map(d => `- ${d.date} (${d.label})`).join("\n");
  return `You are reading the same medical document again. Extract FULL detail ONLY for these specific dates — ignore all others:
${dateList}

Return ONLY valid JSON matching this shape:
{
  "events": [
    {
      "date": "must match one of the dates above",
      "label": "short label",
      "visit_setting": "Primary Care Visit | Specialist Visit | Lab Work | Imaging | ER Visit | Mental Health Visit | Dental Visit | Pharmacy | null",
      "what_happened": "Preventive Care | Follow-up | Acute Care | Mental Health | Specialist Consultation | Lab / Imaging | Chronic Disease Management | Surgery / Procedure | null",
      "provider": "string or null",
      "facility": "string or null",
      "facility_location": "string or null",
      "diagnoses": [ { "description": "string", "icd10cm": "code or null", "confidence": "high | medium | low" } ],
      "notes": "one short sentence or null"
    }
  ]
}`;
}

async function callClaudeRaw(content, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("\n").trim();
  let cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const fb = cleaned.indexOf("{"); const lb = cleaned.lastIndexOf("}");
  if (fb !== -1 && lb !== -1 && lb > fb) cleaned = cleaned.slice(fb, lb + 1);
  try { return JSON.parse(cleaned); } catch (e) { return null; }
}

async function extractDense(base64, mediaType, onProgress) {
  const isPdf = mediaType === "application/pdf";
  const docContent = { type: isPdf ? "document" : "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  onProgress && onProgress("Indexing all visits in this document…");
  const idx = await callClaudeRaw([docContent, { type: "text", text: buildIndexPrompt() }], 4096);
  if (!idx) throw new Error("Could not read this document's index. Please try again.");

  const dates = (idx.dates || []).filter(d => d && d.date);
  if (dates.length === 0) {
    return { ...idx, date: null, events: [], diagnoses: [], procedures: [], medications: [],
      plain_summary: "No dated visits found.", flags: [], extraction_notes: null };
  }

  const batches = chunk(dates, 4);
  const allEvents = [];
  for (let i = 0; i < batches.length; i++) {
    onProgress && onProgress(`Extracting visits ${i * 4 + 1}–${Math.min((i + 1) * 4, dates.length)} of ${dates.length}…`);
    const detail = await callClaudeRaw([docContent, { type: "text", text: buildDetailPrompt(batches[i]) }], 4096);
    if (detail?.events) allEvents.push(...detail.events);
  }

  return {
    patient_name: idx.patient_name || null,
    patient_branch: idx.patient_branch || null,
    patient_era: idx.patient_era || null,
    document_type: idx.document_type || "Multi-visit chart export",
    date: null, provider: null, facility: null,
    facility_location: idx.facility_location || null,
    events: allEvents,
    diagnoses: [], procedures: [], medications: [],
    plain_summary: `${allEvents.length} dated visit${allEvents.length === 1 ? "" : "s"} found across this document.`,
    flags: allEvents.length < dates.length
      ? [`${dates.length - allEvents.length} visit(s) from the index could not be fully detailed.`] : [],
    extraction_notes: null,
  };
}

async function callClaude(base64, mediaType, prompt, onProgress) {
  const isPdf = mediaType === "application/pdf";
  const content = [
    {
      type: isPdf ? "document" : "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    },
    { type: "text", text: prompt },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    if (res.status === 413) {
      const err = new Error("This file is too large for the API to accept, even after our size check.");
      err.oversized = true; throw err;
    }
    throw new Error(`API error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();

  if (data.stop_reason === "max_tokens") {
    return await extractDense(base64, mediaType, onProgress);
  }

  const text = (data.content || []).map(b => b.text || "").join("\n").trim();
  let cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const firstBrace = cleaned.indexOf("{"); const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  try { return JSON.parse(cleaned); }
  catch (e) { throw new Error("Could not parse JSON from response. Raw output:\n\n" + text.slice(0, 800)); }
}


/* ============================ Small UI atoms ============================ */
// A genuinely detailed visit row — used in the Visits panel, year browser, and
// chronological summary, so a visit never reads as a thin one-line writeoff.
// A horizontal zigzag timeline — one color-coded bar segment per year, with circle
// nodes alternating above/below, matching a classic infographic timeline style.
// Years are oldest-to-newest left-to-right (a timeline reads left-to-right as a story,
// even though the rest of the dashboard is newest-first).
const TIMELINE_PALETTE = [
  "#F4B23A", "#F0883D", "#E85D52", "#D8366B", "#A93A9E",
  "#6A3FB0", "#3D5BC4", "#2E8FC4", "#2DA89A", "#4BAE5C",
];

// Slim fixed side navigation — jump to dashboard sections or back to top.
// Only renders once there's a dashboard to navigate (i.e. at least one document done).
const NAV_SECTIONS = [
  { id: "section-overview", label: "Overview", icon: "LayoutGrid" },
  { id: "section-timeline", label: "Timeline", icon: "Clock" },
  { id: "section-visits", label: "Visits", icon: "Stethoscope" },
  { id: "section-medications", label: "Medications", icon: "Layers" },
  { id: "section-conditions", label: "Conditions", icon: "ShieldCheck" },
  { id: "section-search", label: "Search", icon: "Search" },
  { id: "section-summary", label: "Summary", icon: "ListOrdered" },
];

function SideNav({ visible }) {
  const [activeId, setActiveId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [hoverTop, setHoverTop] = useState(false);
  const [showTopBtn, setShowTopBtn] = useState(false);
  // Blocks scroll-tracking while a programmatic scroll is in flight — prevents
  // the scroll handler from immediately overriding the item the user just clicked.
  const scrollingRef = useRef(false);
  const scrollTimerRef = useRef(null);

  React.useEffect(() => {
    if (!visible) return;
    const onScroll = () => {
      setShowTopBtn(window.scrollY > 400);
      // While jumpTo() is running, don't let scroll events fight the clicked state.
      if (scrollingRef.current) return;
      let current = null;
      for (const s of NAV_SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top < 160) current = s.id;
      }
      setActiveId(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [visible]);

  if (!visible) return null;

  const jumpTo = (id) => {
    // Set active immediately on click so it feels instant.
    setActiveId(id);
    // Lock scroll-tracking for long enough for smooth scroll to land (~800 ms).
    scrollingRef.current = true;
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => { scrollingRef.current = false; }, 800);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const ICONS = { LayoutGrid, Clock, Stethoscope, Search, ListOrdered, Layers, ShieldCheck };

  return (
    <div className="no-print" style={{
      position: "fixed", left: 18, top: 0, bottom: 0, margin: "auto", zIndex: 40,
      height: "fit-content",
      display: "flex", flexDirection: "column", gap: 4, background: "#fff",
      border: "1px solid #E1E6EB", borderRadius: 14, padding: 8,
      boxShadow: "0 8px 24px -8px rgba(14,28,43,.18)",
    }}>
      {NAV_SECTIONS.map(s => {
        const Icon = ICONS[s.icon];
        const isActive = activeId === s.id;
        const isHover = hoverId === s.id && !isActive;
        return (
          <button
            key={s.id}
            onClick={() => jumpTo(s.id)}
            onMouseEnter={() => setHoverId(s.id)}
            onMouseLeave={() => setHoverId(null)}
            style={{
              display: "flex", alignItems: "center", gap: 9, padding: "8px 12px 8px 9px", borderRadius: 9,
              background: isActive ? "#0E7C86" : isHover ? "#E9F4F4" : "transparent",
              border: "none", cursor: "pointer",
              color: isActive ? "#fff" : isHover ? "#0E7C86" : "#5C6773",
              transition: "background .12s, color .12s",
              whiteSpace: "nowrap",
            }}
          >
            <Icon size={16} style={{ flex: "none" }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.label}</span>
          </button>
        );
      })}
      <div style={{ height: 1, background: "#E1E6EB", margin: "3px 4px" }} />
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onMouseEnter={() => setHoverTop(true)}
        onMouseLeave={() => setHoverTop(false)}
        style={{
          display: "flex", alignItems: "center", gap: 9, padding: "8px 12px 8px 9px", borderRadius: 9,
          background: showTopBtn ? "#F7EFDC" : hoverTop ? "#F7EFDC" : "transparent",
          border: "none", cursor: "pointer",
          color: showTopBtn || hoverTop ? "#B5852A" : "#C7D2DD",
          transition: "background .12s, color .12s",
          whiteSpace: "nowrap",
        }}
      >
        <ChevronUp size={16} style={{ flex: "none" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Back to top</span>
      </button>
    </div>
  );
}

function YearTimeline({ yearCounts, activeYear, onSelectYear }) {
  if (!yearCounts || yearCounts.length === 0) return null;
  // yearCounts comes in newest-first (matches the rest of the dashboard); flip for
  // a left-to-right chronological read, the natural direction for a timeline.
  const years = [...yearCounts].map(([y, count]) => ({ year: y, count })).sort((a, b) => a.year.localeCompare(b.year));
  const n = years.length;
  const segW = 110;
  const W = Math.max(360, n * segW + 40);
  const barY = 95;
  const barH = 26;
  const stemLen = 38;
  const nodeR = 22;
  // Bubbles sit stemLen away from the bar, plus their own radius — compute real
  // top/bottom extent so the SVG height never clips them, with margin to spare.
  const topY = barY - stemLen - nodeR - 10;
  const bottomY = barY + barH + stemLen + nodeR + 10;
  const H = bottomY - topY;

  return (
    <div style={{ overflowX: "auto", overflowY: "hidden", paddingBottom: 6 }}>
      <svg width={W} height={H} viewBox={`0 ${topY} ${W} ${H}`} style={{ display: "block", minWidth: "100%" }}>
        {years.map(({ year, count }, i) => {
          const x = 20 + i * segW;
          const color = TIMELINE_PALETTE[i % TIMELINE_PALETTE.length];
          const isActive = activeYear === year;
          const above = i % 2 === 0;
          const cy = above ? barY - stemLen : barY + barH + stemLen;
          const stemY1 = above ? barY : barY + barH;
          const stemY2 = above ? cy + nodeR : cy - nodeR;
          const cx = x + segW / 2;
          const isLast = i === n - 1;

          return (
            <g key={year} style={{ cursor: "pointer" }} onClick={() => onSelectYear(year)}>
              {/* Bar segment (arrow-shaped on the last one) */}
              {isLast ? (
                <polygon
                  points={`${x},${barY} ${x + segW - 14},${barY} ${x + segW},${barY + barH / 2} ${x + segW - 14},${barY + barH} ${x},${barY + barH}`}
                  fill={color} opacity={isActive ? 1 : 0.85}
                />
              ) : (
                <rect x={x} y={barY} width={segW} height={barH} fill={color} opacity={isActive ? 1 : 0.85} />
              )}
              <text x={cx} y={barY + barH / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="'IBM Plex Mono',monospace">
                {year}
              </text>

              {/* Stem connecting bar to circle */}
              <line x1={cx} y1={stemY1} x2={cx} y2={stemY2} stroke={color} strokeWidth="2" opacity={isActive ? 1 : 0.6} />

              {/* Circle node — shows visit count, not the year (year is already on the bar) */}
              <circle cx={cx} cy={cy} r={nodeR} fill="#fff" stroke={color} strokeWidth={isActive ? 3 : 2} />
              <text x={cx} y={cy - 1} textAnchor="middle" fontSize="14" fontWeight="700" fill={isActive ? color : "#16222F"} className="disp">
                {count}
              </text>
              <text x={cx} y={cy + 12} textAnchor="middle" fontSize="7.5" fontWeight="600" fill={isActive ? color : "#8A95A1"} letterSpacing=".03em">
                {count === 1 ? "VISIT" : "VISITS"}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function VisitRow({ d, term }) {
  const [showNotes, setShowNotes] = useState(false);
  const dx = (d.diagnoses || []).filter(x => x.icd10cm); // only coded diagnoses in the card
  const hasNotes = !!(d.plain_summary && d.plain_summary.length > 0);
  const mainIssue = (d.what_happened && d.what_happened !== 'null' ? d.what_happened : null) || (d.document_type && d.document_type !== 'null' ? d.document_type : null) || "Visit";

  return (
    <div style={{ padding: "13px 15px", borderRadius: 12, background: "#F8FAFB", border: "1px solid #EEF1F4" }}>

      {/* Date + visit type tag */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 12, color: "#0E7C86", fontWeight: 700 }}>
          {formatNarrativeDate(d.date)}
        </span>
        {d.visit_setting && (
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: ".02em", color: "#B5852A",
            background: "#F7EFDC", padding: "2px 8px", borderRadius: 999,
          }}>
            {d.visit_setting !== 'null' ? d.visit_setting : null}
          </span>
        )}
      </div>

      {/* Main issue — the headline */}
      <div style={{ fontSize: 14.5, fontWeight: 700, color: "#16222F", marginBottom: 5, lineHeight: 1.3 }}>
        <Highlight text={mainIssue} term={term} />
      </div>

      {/* Doctor + Location — clean labeled line */}
      {(d.provider || d.facility || d.facility_location) && (
        <div style={{ fontSize: 12.5, color: "#5C6773", display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
          {d.provider && (
            <span><strong style={{ color: "#42505E", fontWeight: 600 }}>Doctor:</strong> {d.provider}</span>
          )}
          {(d.facility || d.facility_location) && (
            <span><strong style={{ color: "#42505E", fontWeight: 600 }}>Location:</strong> {[d.facility, d.facility_location].filter(Boolean).join(", ")}</span>
          )}
        </div>
      )}

      {/* ICD-10-CM codes — labeled so a veteran knows what the code refers to */}
      {dx.length > 0 && (
        <div style={{ marginTop: 7 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8A95A1", letterSpacing: ".04em", marginRight: 6 }}>
            ICD-10-CM:
          </span>
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 5 }}>
            {dx.map((x, i) => (
              <span key={i} className="mono" style={{
                fontSize: 10, fontWeight: 700, color: "#42505E", background: "#EEF1F4",
                padding: "2px 8px", borderRadius: 999,
              }}>
                {x.icd10cm}{x.description ? ` · ${x.description}` : ""}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* Notes — expandable on demand */}
      {hasNotes && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setShowNotes(s => !s)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600,
              color: showNotes ? "#0E7C86" : "#8A95A1", background: "none", border: "none",
              cursor: "pointer", padding: 0,
            }}
          >
            <FileText size={12} />
            {showNotes ? "Hide notes" : "View notes"}
          </button>
          {showNotes && (
            <p style={{
              fontSize: 12.5, color: "#374251", marginTop: 6, marginBottom: 0,
              lineHeight: 1.65, padding: "9px 11px", background: "#fff",
              border: "1px solid #E1E6EB", borderRadius: 8,
            }}>
              <Highlight text={d.plain_summary} term={term} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ChronoRow — same clean veteran-facing card as VisitRow, but styled for the
// timeline rail in the chronological summary (dot + indent rather than a card box).
function ChronoRow({ d, search }) {
  const [showNotes, setShowNotes] = useState(false);
  const dx = (d.diagnoses || []).filter(x => x.icd10cm);
  const hasNotes = !!(d.plain_summary && d.plain_summary.length > 0);
  const mainIssue = (d.what_happened && d.what_happened !== 'null' ? d.what_happened : null) || buildNarrativeLine(d);

  return (
    <div style={{ display: "flex", gap: 16, position: "relative" }}>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: "#0E7C86", flex: "none", marginTop: 4, zIndex: 1 }} />
      <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 12, color: "#0E7C86", fontWeight: 600 }}>
            {formatNarrativeDate(d.date)}
          </span>
          {d.visit_setting && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: ".02em", color: "#B5852A",
              background: "#F7EFDC", padding: "2px 8px", borderRadius: 999,
            }}>
              {d.visit_setting !== 'null' ? d.visit_setting : null}
            </span>
          )}
        </div>

        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4, color: "#16222F" }}>
          <Highlight text={mainIssue} term={search} />
        </div>

        {(d.provider || d.facility || d.facility_location) && (
          <div style={{ fontSize: 12.5, color: "#5C6773", marginTop: 3, display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
            {d.provider && <span><strong style={{ color: "#42505E", fontWeight: 600 }}>Doctor:</strong> {d.provider}</span>}
            {(d.facility || d.facility_location) && (
              <span><strong style={{ color: "#42505E", fontWeight: 600 }}>Location:</strong> {[d.facility, d.facility_location].filter(Boolean).join(", ")}</span>
            )}
          </div>
        )}

        {dx.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#8A95A1", letterSpacing: ".04em", marginRight: 6 }}>
              ICD-10-CM:
            </span>
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 5 }}>
              {dx.map((x, i) => (
                <span key={i} className="mono" style={{
                  fontSize: 10, fontWeight: 700, color: "#42505E", background: "#EEF1F4",
                  padding: "2px 8px", borderRadius: 999,
                }}>{x.icd10cm}{x.description ? ` · ${x.description}` : ""}</span>
              ))}
            </span>
          </div>
        )}

        {hasNotes && (
          <div style={{ marginTop: 7 }}>
            <button
              onClick={() => setShowNotes(s => !s)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600,
                color: showNotes ? "#0E7C86" : "#8A95A1", background: "none", border: "none",
                cursor: "pointer", padding: 0,
              }}
            >
              <FileText size={12} />
              {showNotes ? "Hide notes" : "View notes"}
            </button>
            {showNotes && (
              <p style={{
                fontSize: 12.5, color: "#374251", marginTop: 6, marginBottom: 0,
                lineHeight: 1.65, padding: "9px 11px", background: "#fff",
                border: "1px solid #E1E6EB", borderRadius: 8,
              }}>
                <Highlight text={d.plain_summary} term={search} />
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Highlight({ text, term }) {
  if (!text) return null;
  if (!term || !term.trim()) return <>{text}</>;
  const t = term.trim();
  const idx = text.toLowerCase().indexOf(t.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + t.length)}</mark>
      {text.slice(idx + t.length)}
    </>
  );
}

function Badge({ children, tone = "default" }) {
  const tones = {
    default: { bg: "#EEF1F4", fg: "#42505E" },
    high: { bg: "#E3F3E8", fg: "#1E7B3C" },
    medium: { bg: "#FFF3DA", fg: "#9A6B00" },
    low: { bg: "#FBE7E5", fg: "#B4302A" },
  };
  const t = tones[tone] || tones.default;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: t.bg, color: t.fg, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "#8A95A1", marginBottom: 5, textTransform: "uppercase" }} title={FIELD_HELP[label]}>
        {label.replace(/_/g, " ")}
      </div>
      {children}
    </div>
  );
}

/* ============================ Result card ============================ */
/* ============================ Conflict modal ============================ */
/* ============================ Download modal ============================ */
function DownloadModal({ onDownload, onClose }) {
  const [generating, setGenerating] = useState(false);
  const [done, setDone] = useState(null); // "veteran" | "clinical"

  const handle = async (mode) => {
    setGenerating(mode);
    try { await onDownload(mode); setDone(mode); }
    catch (e) { console.error(e); }
    finally { setGenerating(false); }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(14,28,43,.72)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 18, maxWidth: 480, width: "100%",
        boxShadow: "0 24px 60px -12px rgba(0,0,0,.5)", overflow: "hidden",
      }}>
        <div style={{ background: "#0E1C2B", padding: "18px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Download size={17} color="#B5852A" />
            <span className="disp" style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Download your record</span>
          </div>
        </div>
        <div style={{ height: 2, background: "#B5852A" }} />

        <div style={{ padding: "20px 22px" }}>
          <p style={{ fontSize: 13.5, color: "#5C6773", lineHeight: 1.6, marginBottom: 18 }}>
            Choose how you'd like your record formatted. You can download both versions — they'll save as separate files.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Veteran summary */}
            <button
              onClick={() => handle("veteran")}
              disabled={!!generating}
              style={{
                display: "flex", gap: 14, padding: "15px 16px", borderRadius: 12, textAlign: "left",
                border: "1.5px solid " + (done === "veteran" ? "#9DBE8C" : "#DDE2E7"),
                background: done === "veteran" ? "#F6FAF3" : "#fff",
                cursor: generating ? "default" : "pointer", opacity: generating === "clinical" ? .5 : 1,
              }}
            >
              <span style={{
                width: 38, height: 38, borderRadius: 10, flex: "none", display: "flex",
                alignItems: "center", justifyContent: "center",
                background: done === "veteran" ? "#E4EEE0" : "#E9F4F4", color: done === "veteran" ? "#5C7A4E" : "#0E7C86",
              }}>
                {generating === "veteran" ? <Loader size={18} className="spin" /> : done === "veteran" ? <Check size={18} /> : <FileText size={18} />}
              </span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#16222F" }}>Veteran Summary</div>
                <div style={{ fontSize: 12.5, color: "#5C6773", marginTop: 3, lineHeight: 1.5 }}>
                  Clean and readable — date, visit type, main issue, doctor, location, and ICD codes. Notes are omitted. Ideal for sharing with a new provider or keeping on hand.
                </div>
              </div>
            </button>

            {/* Clinical detail */}
            <button
              onClick={() => handle("clinical")}
              disabled={!!generating}
              style={{
                display: "flex", gap: 14, padding: "15px 16px", borderRadius: 12, textAlign: "left",
                border: "1.5px solid " + (done === "clinical" ? "#9DBE8C" : "#DDE2E7"),
                background: done === "clinical" ? "#F6FAF3" : "#fff",
                cursor: generating ? "default" : "pointer", opacity: generating === "veteran" ? .5 : 1,
              }}
            >
              <span style={{
                width: 38, height: 38, borderRadius: 10, flex: "none", display: "flex",
                alignItems: "center", justifyContent: "center",
                background: done === "clinical" ? "#E4EEE0" : "#F7EFDC", color: done === "clinical" ? "#5C7A4E" : "#B5852A",
              }}>
                {generating === "clinical" ? <Loader size={18} className="spin" /> : done === "clinical" ? <Check size={18} /> : <FileText size={18} />}
              </span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#16222F" }}>Clinical Detail</div>
                <div style={{ fontSize: 12.5, color: "#5C6773", marginTop: 3, lineHeight: 1.5 }}>
                  Everything — full diagnoses with descriptions, all ICD codes, and clinical notes. For medical teams, specialists, or your own full records request.
                </div>
              </div>
            </button>
          </div>

          {done && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: "#5C7A4E", display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={13} /> Downloaded — check your downloads folder.
            </div>
          )}

          <button onClick={onClose} style={{
            marginTop: 16, width: "100%", background: "none", border: "1px solid #DDE2E7",
            borderRadius: 10, padding: "10px", fontSize: 13, color: "#8A95A1", cursor: "pointer", fontWeight: 600,
          }}>
            {done ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictModal({ modal, onDismissIncoming, onClearVaultAndAccept, onChooseName, onClose }) {
  const [customName, setCustomName] = useState("");
  if (!modal) return null;

  const headerText = {
    no_medical: "No medical records found",
    name_conflict: "Different patient detected",
    name_chooser: "What name should appear on this record?",
  }[modal.type] || "Heads up";

  const headerIcon = modal.type === "name_chooser"
    ? <span style={{ fontSize: 18 }}>✏️</span>
    : <AlertTriangle size={18} color="#B5852A" />;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(14,28,43,.72)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 18, maxWidth: 520, width: "100%",
        boxShadow: "0 24px 60px -12px rgba(0,0,0,.5)", overflow: "hidden",
      }}>
        <div style={{ background: "#0E1C2B", padding: "18px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {headerIcon}
            <span className="disp" style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>{headerText}</span>
          </div>
        </div>
        <div style={{ height: 2, background: "#B5852A" }} />

        <div style={{ padding: "20px 22px" }}>

          {/* No medical content */}
          {modal.type === "no_medical" && (
            <>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: "#374251", marginBottom: 18 }}>
                We couldn't find any medical information in this document. It may be a photo, a blank form, or something unrelated. We haven't added it to your vault.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={onClose} style={{
                  background: "#0E7C86", color: "#fff", border: "none", borderRadius: 10,
                  padding: "10px 20px", fontWeight: 700, fontSize: 13.5, cursor: "pointer",
                }}>Got it</button>
              </div>
            </>
          )}

          {/* Genuinely different person — first names don't match */}
          {modal.type === "name_conflict" && (
            <>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: "#374251", marginBottom: 6 }}>
                Your vault is for <strong style={{ color: "#0E7C86" }}>{modal.established}</strong>, but this document is for <strong style={{ color: "#B5852A" }}>{modal.incoming}</strong>. These appear to be different people.
              </p>
              <p style={{ fontSize: 13, color: "#5C6773", lineHeight: 1.55, marginBottom: 20 }}>
                Mixing records from two different patients could cause serious errors. Please choose how to proceed:
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button onClick={onDismissIncoming} style={{
                  background: "#fff", border: "1.5px solid #DDE2E7", borderRadius: 10,
                  padding: "12px 16px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", textAlign: "left",
                }}>
                  <div style={{ fontWeight: 700 }}>Discard this document</div>
                  <div style={{ fontSize: 12, color: "#8A95A1", marginTop: 3 }}>Keep the vault as-is for {modal.established}</div>
                </button>
                <button onClick={onClearVaultAndAccept} style={{
                  background: "#FDF4F3", border: "1.5px solid #F0C4C0", borderRadius: 10,
                  padding: "12px 16px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", textAlign: "left",
                }}>
                  <div style={{ fontWeight: 700, color: "#B4302A" }}>Clear vault and start fresh for {modal.incoming}</div>
                  <div style={{ fontSize: 12, color: "#B4302A", marginTop: 3 }}>Removes all currently uploaded records</div>
                </button>
              </div>
            </>
          )}

          {/* Name chooser — same person, multiple last names over time */}
          {modal.type === "name_chooser" && (
            <>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: "#374251", marginBottom: 6 }}>
                We found records under <strong>{modal.names.length} different names</strong>. This is common when records span a name change — for example, through marriage.
              </p>
              <p style={{ fontSize: 13, color: "#5C6773", lineHeight: 1.55, marginBottom: 16 }}>
                All records are in your vault. Choose which name should appear on your summary and any printouts:
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {modal.names.map((name, i) => (
                  <button key={i} onClick={() => onChooseName(name)} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                    borderRadius: 10, border: "1.5px solid #DDE2E7", background: "#fff",
                    cursor: "pointer", textAlign: "left", fontWeight: 600, fontSize: 14,
                  }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: 999, flex: "none",
                      background: "linear-gradient(150deg,#2C4A63,#0E7C86)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#fff", fontWeight: 700, fontSize: 11,
                    }}>
                      {name.split(" ").map(w => w[0]).join("").slice(0, 2)}
                    </span>
                    {name}
                  </button>
                ))}
              </div>

              <div style={{ borderTop: "1px solid #EEF1F4", paddingTop: 14 }}>
                <div style={{ fontSize: 12.5, color: "#5C6773", marginBottom: 8 }}>
                  Or enter a different name to display:
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={customName}
                    onChange={e => setCustomName(e.target.value)}
                    placeholder="Type a name…"
                    style={{
                      flex: 1, fontSize: 14, padding: "9px 12px", borderRadius: 9,
                      border: "1px solid #DDE2E7", outline: "none",
                    }}
                  />
                  <button
                    onClick={() => customName.trim() && onChooseName(customName.trim())}
                    disabled={!customName.trim()}
                    style={{
                      background: customName.trim() ? "#0E7C86" : "#EEF1F4",
                      color: customName.trim() ? "#fff" : "#8A95A1",
                      border: "none", borderRadius: 9, padding: "9px 16px",
                      fontWeight: 700, fontSize: 13.5, cursor: customName.trim() ? "pointer" : "default",
                    }}
                  >Use this name</button>
                </div>
              </div>

              <button onClick={onClose} style={{
                marginTop: 12, width: "100%", background: "none", border: "none",
                fontSize: 13, color: "#8A95A1", cursor: "pointer", padding: "8px",
              }}>Decide later</button>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

function ResultCard({ item, onRemove, onRetry }) {
  const [showJson, setShowJson] = useState(false);
  const d = item.data;

  if (item.status === "error") {
    return (
      <div style={{ border: "1px solid #F0C4C0", background: "#FDF4F3", borderRadius: 10, padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <AlertTriangle size={18} color="#B4302A" style={{ flex: "none", marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: "#1B1B1B" }}>{item.filename}</div>
            <div style={{ fontSize: 12.5, color: "#B4302A", marginTop: 4 }}>{item.error}</div>

            {item.oversized && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: "#fff", border: "1px solid #F0C4C0", borderRadius: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1B1B1B", marginBottom: 4 }}>
                  Compress the PDF, then re-upload it
                </div>
                <div style={{ fontSize: 12, color: "#5C6773", lineHeight: 1.6, marginBottom: 8 }}>
                  Most of the size in a scanned medical record comes from high-resolution images on each page. We suggest Adobe's compressor since it's a name you can trust with personal health information.
                </div>
                <a href="https://www.adobe.com/acrobat/online/compress-pdf.html" target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12.5, fontWeight: 700, color: "#3D6DB5", textDecoration: "underline" }}>
                  Compress PDF — Adobe ↗
                </a>
              </div>
            )}

            {item.truncated && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: "#fff", border: "1px solid #F0C4C0", borderRadius: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1B1B1B", marginBottom: 4 }}>
                  This one needs another try
                </div>
                <div style={{ fontSize: 12, color: "#5C6773", lineHeight: 1.6, marginBottom: 8 }}>
                  This document is unusually dense. Tap retry and we'll process it again.
                </div>
                {onRetry && (
                  <button onClick={onRetry} style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#fff",
                    background: "#0E7C86", border: "none", borderRadius: 7, padding: "7px 14px",
                  }}>
                    <RotateCcw size={12} /> Retry
                  </button>
                )}
              </div>
            )}
          </div>
          <button onClick={onRemove} style={{ color: "#8A95A1", flex: "none" }}><X size={16} /></button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #DDE2E7", background: "#fff", borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "13px 16px", borderBottom: "1px solid #EEF1F4", display: "flex", alignItems: "center", gap: 10 }}>
        <FileText size={16} color="#42505E" style={{ flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: "#1B1B1B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.filename}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A95A1" }}>
            {d.document_type || "Unknown type"} ·{" "}
            {d.events && d.events.length > 0
              ? `${d.events.length} dated visit${d.events.length === 1 ? "" : "s"} found in this document`
              : d.date || "no date found"}
          </div>
          {item.note && <div style={{ fontSize: 10.5, color: "#9A6B00", marginTop: 2 }}>{item.note}</div>}
        </div>
        <button onClick={() => setShowJson(s => !s)} style={{
          display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: "#42505E",
          padding: "5px 9px", borderRadius: 7, border: "1px solid #DDE2E7", flex: "none",
        }}>
          <Code size={12} /> {showJson ? "Hide" : "Raw"} JSON
        </button>
        <button onClick={onRemove} style={{ color: "#8A95A1", flex: "none" }}><Trash2 size={15} /></button>
      </div>

      <div style={{ padding: "16px 18px" }}>
        <Field label="plain_summary">
          <p style={{ fontSize: 13.5, color: "#1B1B1B", lineHeight: 1.55, margin: 0 }}>{d.plain_summary || "—"}</p>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label="visit_setting">
            <span style={{ fontSize: 13 }}>{d.visit_setting || "—"}</span>
          </Field>
          <Field label="what_happened">
            <span style={{ fontSize: 13 }}>{d.what_happened || "—"}</span>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <Field label="provider">
            <span style={{ fontSize: 13 }}>{d.provider || "—"}</span>
          </Field>
          <Field label="facility">
            <span style={{ fontSize: 13 }}>{d.facility || "—"}</span>
          </Field>
          <Field label="facility_location">
            <span style={{ fontSize: 13 }}>{d.facility_location || "—"}</span>
          </Field>
        </div>

        {d.events && d.events.length > 0 && (
          <Field label="events (multiple dates found in this document)">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {d.events.map((ev, i) => (
                <div key={i} style={{ padding: "9px 11px", borderRadius: 8, background: "#F8FAFB", border: "1px solid #EEF1F4" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "#0E7C86" }}>{ev.date || "undated"}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{ev.what_happened || ev.label || "Visit"}</span>
                  </div>
                  {(ev.visit_setting || ev.provider || ev.facility) && (
                    <div style={{ fontSize: 11.5, color: "#8A95A1" }}>
                      {[ev.visit_setting, ev.provider, ev.facility].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  {ev.diagnoses && ev.diagnoses.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                      {ev.diagnoses.map((dx, j) => (
                        <span key={j} className="mono" style={{
                          fontSize: 10.5, fontWeight: 700, color: "#42505E", background: "#EEF1F4", padding: "2px 7px", borderRadius: 999,
                        }}>
                          {dx.icd10cm || "uncoded"} · {dx.description}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Field>
        )}

        {d.diagnoses && d.diagnoses.length > 0 && (
          <Field label="diagnoses">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {d.diagnoses.map((dx, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{dx.description}</span>
                  {dx.icd10cm && <Badge tone="default">{dx.icd10cm}</Badge>}
                  {dx.confidence && <Badge tone={dx.confidence}>{dx.confidence}</Badge>}
                </div>
              ))}
            </div>
          </Field>
        )}

        {d.procedures && d.procedures.length > 0 && (
          <Field label="procedures">
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              {d.procedures.map((p, i) => <div key={i}>• {p.description}{p.date ? ` (${p.date})` : ""}</div>)}
            </div>
          </Field>
        )}

        {d.medications && d.medications.length > 0 && (
          <Field label="medications">
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              {d.medications.map((m, i) => <div key={i}>• {m.name}{m.dose ? `, ${m.dose}` : ""}{m.instructions ? ` — ${m.instructions}` : ""}</div>)}
            </div>
          </Field>
        )}

        {d.flags && d.flags.length > 0 && (
          <Field label="flags">
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {d.flags.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 7, fontSize: 12.5, color: "#9A6B00" }}>
                  <AlertTriangle size={13} style={{ flex: "none", marginTop: 1 }} /> {f}
                </div>
              ))}
            </div>
          </Field>
        )}

        {d.extraction_notes && (
          <Field label="extraction_notes">
            <p style={{ fontSize: 12.5, color: "#8A95A1", fontStyle: "italic", margin: 0 }}>{d.extraction_notes}</p>
          </Field>
        )}

        {showJson && (
          <pre style={{
            marginTop: 10, fontSize: 11, background: "#1B2430", color: "#C9D4DD", padding: 14, borderRadius: 8,
            overflowX: "auto", lineHeight: 1.6,
          }}>{JSON.stringify(d, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

/* ============================ Main app ============================ */
/* ============================ Dashboard helpers ============================ */

// A single uploaded document may represent ONE dated entry (the common case) or, for
// documents like a multi-year chart export, MULTIPLE dated entries via the events array.
// This flattens every result into a consistent list of timeline entries so the rest of
// the dashboard (stats, narrative, search, locations) never has to special-case either shape.
// Each returned entry carries: id, sourceId (the original document), date, and the fields
// needed for display — falling back to the document's own top-level fields when a
// document has no events (single-visit case).
/* ============================ Identity validation ============================ */

// Normalizes a name for comparison: strips titles, punctuation, extra whitespace,
// lowercases. "Gloria M. Dent" and "GLORIA DENT" both become "gloria dent".
function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|miss|sgt|cpl|pvt|ssgt|sfc|1sgt|csm|lt|cpt|maj|col|gen|jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true if two names are the SAME person — tolerates middle initials,
// formatting differences, and crucially: same first name with a different last name
// (marriage, legal name change). Only returns false when first names are genuinely
// different, which is the real signal for two different humans.
function namesSamePerson(a, b) {
  if (!a || !b) return true; // can't determine a conflict if either is null
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return true;
  const partsA = na.split(" ").filter(Boolean);
  const partsB = nb.split(" ").filter(Boolean);
  const firstA = partsA[0];
  const firstB = partsB[0];
  // If first names match (or one is an initial of the other), treat as same person
  // regardless of last name — handles Gloria Wilson / Gloria Farrow / Gloria Dent.
  if (!firstA || !firstB) return true;
  if (firstA === firstB) return true;
  if ((firstA[0] === firstB[0]) && (firstA.length === 1 || firstB.length === 1)) return true;
  // First names genuinely differ — different person.
  return false;
}

// Returns true if two names are clearly the SAME PERSON but with a different last name
// (i.e. a name change over time — marriage etc). Used to quietly accept and track history.
function isNameChange(a, b) {
  if (!a || !b) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return false; // same name, not a change
  const partsA = na.split(" ").filter(Boolean);
  const partsB = nb.split(" ").filter(Boolean);
  const firstA = partsA[0]; const firstB = partsB[0];
  const lastA = partsA[partsA.length - 1]; const lastB = partsB[partsB.length - 1];
  if (!firstA || !firstB) return false;
  const firstMatch = firstA === firstB || ((firstA[0] === firstB[0]) && (firstA.length === 1 || firstB.length === 1));
  return firstMatch && lastA !== lastB;
}

// Checks whether extracted data contains any recognizable medical content.
function hasMedicalContent(d) {
  if (!d) return false;
  const hasDiagnoses = d.diagnoses && d.diagnoses.length > 0;
  const hasEvents = d.events && d.events.some(e => e.diagnoses && e.diagnoses.length > 0);
  const hasMeds = d.medications && d.medications.length > 0;
  const hasProcs = d.procedures && d.procedures.length > 0;
  const hasSummary = d.plain_summary && d.plain_summary.length > 20;
  const hasProvider = !!(d.provider || d.facility);
  const hasDate = !!(d.date || (d.events && d.events.some(e => e.date)));
  // Needs at least two of: summary, provider/facility, date, diagnoses/meds/procs
  const signals = [hasDiagnoses || hasEvents, hasMeds, hasProcs, hasSummary, hasProvider, hasDate];
  return signals.filter(Boolean).length >= 2;
}

function expandEvents(results) {
  const entries = [];
  results.filter(r => r.status === "done").forEach(r => {
    const d = r.data;
    if (d.events && d.events.length > 0) {
      d.events.forEach((ev, i) => {
        entries.push({
          id: `${r.id}-ev${i}`,
          sourceId: r.id,
          sourceFilename: r.filename,
          date: ev.date || null,
          document_type: ev.label || d.document_type || "Visit",
          visit_setting: ev.visit_setting || d.visit_setting || null,
          what_happened: ev.what_happened || d.what_happened || null,
          provider: ev.provider || null,
          facility: ev.facility || null,
          facility_location: ev.facility_location || d.facility_location || null,
          diagnoses: ev.diagnoses || [],
          plain_summary: ev.notes || null,
          isMultiEvent: true,
        });
      });
    } else {
      entries.push({
        id: r.id,
        sourceId: r.id,
        sourceFilename: r.filename,
        date: d.date || null,
        document_type: d.document_type || "Visit",
        visit_setting: d.visit_setting || null,
        what_happened: d.what_happened || null,
        provider: d.provider || null,
        facility: d.facility || null,
        facility_location: d.facility_location || null,
        diagnoses: d.diagnoses || [],
        plain_summary: d.plain_summary || null,
        isMultiEvent: false,
      });
    }
  });
  return entries;
}

function formatNarrativeDate(dateStr) {
  if (!dateStr) return "Undated";
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

// Builds one narrative sentence per visit, the way you'd describe it to a friend —
// leads with what_happened (plain, veteran language) rather than clinical document type.
function buildNarrativeLine(d) {
  const who = d.provider ? `Dr. ${d.provider.replace(/^Dr\.?\s*/i, "")}` : "a provider";
  const where = d.facility ? ` at ${d.facility}` : "";
  if (d.what_happened) {
    return `${d.what_happened} with ${who}${where}.`;
  }
  const what = d.visit_setting ? d.visit_setting.toLowerCase() : (d.document_type ? d.document_type.toLowerCase() : "a visit");
  const dx = (d.diagnoses || []).map(x => x.description).filter(Boolean);
  const reason = dx.length > 0 ? ` for ${dx.slice(0, 2).join(" and ")}` : "";
  return `Saw ${who}${where} — ${what}${reason}.`;
}

// Derives a single "who is this" from whatever's been extracted so far —
// the closest equivalent to a real Login.gov/ID.me session until that's wired up.
function deriveIdentity(results) {
  const done = results.filter(r => r.status === "done").map(r => r.data);
  const branches = {}, eras = {};
  let mostRecentName = null, mostRecentDate = null;
  let priorNames = new Set();

  done.forEach(d => {
    if (d.patient_branch) branches[d.patient_branch] = (branches[d.patient_branch] || 0) + 1;
    if (d.patient_era) eras[d.patient_era] = (eras[d.patient_era] || 0) + 1;

    if (d.patient_name) {
      // Name reflects the most recent dated document — handles a legal name change
      // (e.g. marriage) correctly, where frequency would otherwise favor the old name.
      const hasDate = d.date && /^\d{4}/.test(d.date);
      if (hasDate && (!mostRecentDate || d.date > mostRecentDate)) {
        if (mostRecentName && mostRecentName !== d.patient_name) priorNames.add(mostRecentName);
        mostRecentName = d.patient_name;
        mostRecentDate = d.date;
      } else if (!mostRecentDate && !mostRecentName) {
        // No dated documents seen yet at all — fall back to the first name we find.
        mostRecentName = d.patient_name;
      } else if (d.patient_name !== mostRecentName) {
        priorNames.add(d.patient_name);
      }
    }
  });
  priorNames.delete(mostRecentName);

  const top = (obj) => {
    const entries = Object.entries(obj);
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  };

  return {
    fullName: mostRecentName,
    firstName: mostRecentName ? mostRecentName.split(" ")[0] : null,
    branch: top(branches),
    era: top(eras),
    priorNames: Array.from(priorNames),
  };
}

function computeStats(results) {
  const entries = expandEvents(results);
  const typeCounts = {};
  const settingCounts = {};
  const whatHappenedCounts = {};
  const dxCounts = {};
  const locationCounts = {};
  const yearCounts = {};
  let withCode = 0, totalDx = 0;
  let earliest = null, latest = null;

  entries.forEach(e => {
    const t = e.document_type || "Other";
    typeCounts[t] = (typeCounts[t] || 0) + 1;

    const setting = e.visit_setting && e.visit_setting !== "null" ? e.visit_setting : null;
    const happened = e.what_happened && e.what_happened !== "null" ? e.what_happened : null;

    if (setting) {
      settingCounts[setting] = (settingCounts[setting] || 0) + 1;
    }
    if (happened) {
      whatHappenedCounts[happened] = (whatHappenedCounts[happened] || 0) + 1;
    }
    (e.diagnoses || []).forEach(dx => {
      const key = dx.description || "Unspecified";
      dxCounts[key] = (dxCounts[key] || 0) + 1;
      totalDx++;
      if (dx.icd10cm) withCode++;
    });
    if (e.facility_location) {
      locationCounts[e.facility_location] = (locationCounts[e.facility_location] || 0) + 1;
    }
    if (e.date && /^\d{4}/.test(e.date)) {
      if (!earliest || e.date < earliest) earliest = e.date;
      if (!latest || e.date > latest) latest = e.date;
      const year = e.date.slice(0, 4);
      yearCounts[year] = (yearCounts[year] || 0) + 1;
    }
  });

  return {
    totalDocs: results.filter(r => r.status === "done").length,
    totalVisits: entries.length,
    typeCounts: Object.entries(typeCounts).sort((a, b) => b[1] - a[1]),
    settingCounts: Object.entries(settingCounts).sort((a, b) => b[1] - a[1]),
    whatHappenedCounts: Object.entries(whatHappenedCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    topDiagnoses: Object.entries(dxCounts).sort((a, b) => b[1] - a[1]).slice(0, 6),
    locationCounts: Object.entries(locationCounts).sort((a, b) => b[1] - a[1]),
    yearCounts: Object.entries(yearCounts).sort((a, b) => b[0].localeCompare(a[0])),
    codedPct: totalDx > 0 ? Math.round((withCode / totalDx) * 100) : 0,
    earliest, latest,
  };
}

// Returns true if a timeline entry matches a free-text or ICD-10-CM search term.
function matchesSearch(e, term) {
  if (!term) return true;
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const haystack = [
    e.document_type, e.provider, e.facility, e.plain_summary,
    ...(e.diagnoses || []).flatMap(x => [x.description, x.icd10cm]),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(t);
}

/* ============================ PDF generation — canvas-based, no external libs ============================ */
// Generates a PDF entirely in the browser using Canvas + a minimal PDF byte builder.
// No CDN, no external scripts — works in sandboxed environments like Claude artifacts.

function canvasToPdfBytes(canvasList) {
  // Minimal PDF builder — one image object per canvas page.
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let pos = 0;

  const write = (str) => {
    const bytes = encoder.encode(str);
    parts.push(bytes);
    pos += bytes.length;
    return bytes.length;
  };

  const writeBin = (bytes) => {
    parts.push(bytes);
    pos += bytes.length;
  };

  const W_PT = 612, H_PT = 792;
  const numPages = canvasList.length;

  // Header
  write('%PDF-1.4\n');

  // Each page: we store XObject image + page objects
  const imgObjNums = [], pageObjNums = [];
  const catalogObj = 1, pagesObj = 2;
  let objNum = 3;

  const imageDataList = canvasList.map(canvas => {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { canvas, imgData };
  });

  // We'll use JPEG streams embedded in the PDF
  const jpegDataList = canvasList.map(canvas => {
    const dataURL = canvas.toDataURL('image/jpeg', 0.92);
    const b64 = dataURL.split(',')[1];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });

  // Write image stream objects
  jpegDataList.forEach((jpegBytes, i) => {
    const imgObj = objNum++;
    imgObjNums.push(imgObj);
    offsets[imgObj] = pos;
    write(`${imgObj} 0 obj\n`);
    write(`<< /Type /XObject /Subtype /Image /Width ${canvasList[i].width} /Height ${canvasList[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\n`);
    write('stream\n');
    writeBin(jpegBytes);
    write('\nendstream\nendobj\n');
  });

  // Write page objects
  canvasList.forEach((canvas, i) => {
    const pageObj = objNum++;
    pageObjNums.push(pageObj);
    const contentObj = objNum++;
    const stream = `q ${W_PT} 0 0 ${H_PT} 0 0 cm /Im${i} Do Q`;
    offsets[contentObj] = pos;
    write(`${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    offsets[pageObj] = pos;
    write(`${pageObj} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W_PT} ${H_PT}] /Contents ${contentObj} 0 R /Resources << /XObject << /Im${i} ${imgObjNums[i]} 0 R >> >> >>\nendobj\n`);
  });

  // Pages object
  offsets[pagesObj] = pos;
  const kidsStr = pageObjNums.map(n => `${n} 0 R`).join(' ');
  write(`${pagesObj} 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${numPages} >>\nendobj\n`);

  // Catalog
  offsets[catalogObj] = pos;
  write(`${catalogObj} 0 obj\n<< /Type /Catalog /Pages ${pagesObj} 0 R >>\nendobj\n`);

  // Xref
  const xrefPos = pos;
  const totalObjs = objNum;
  write(`xref\n0 ${totalObjs}\n`);
  write('0000000000 65535 f \n');
  for (let i = 1; i < totalObjs; i++) {
    write((offsets[i] || 0).toString().padStart(10, '0') + ' 00000 n \n');
  }
  write(`trailer\n<< /Size ${totalObjs} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\nEOF\n`);

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  parts.forEach(p => { result.set(p, offset); offset += p.length; });
  return result;
}

async function generatePDF(entries, identity, stats, patientName, mode, dob = null) {
  // Canvas text only renders a custom font if it's actually loaded by the time we
  // draw — without this wait, every font.load() call below silently falls back
  // to the system default (Arial), which is why the PDF looked generic compared
  // to the live site even though the CSS @import was already in place for screen use.
  try {
    await Promise.all([
      document.fonts.load('700 24px "Space Grotesk"'),
      document.fonts.load('700 20px "IBM Plex Mono"'),
      document.fonts.load('500 20px "IBM Plex Mono"'),
      document.fonts.load('400 19px "Inter"'),
      document.fonts.load('600 19px "Inter"'),
      document.fonts.load('700 19px "Inter"'),
    ]);
    await document.fonts.ready;
  } catch (e) { /* fonts unavailable — falls back gracefully to system sans-serif */ }

  const FONT_DISPLAY = '"Space Grotesk", Arial, sans-serif';
  const FONT_BODY = '"Inter", Arial, sans-serif';
  const FONT_MONO = '"IBM Plex Mono", "Courier New", monospace';

  const W = 1200, H = 1556; // 2x letter at 96dpi equivalent — sharp on all screens
  const MARGIN = 80, LINE = 26, SMALL_LINE = 20;
  const pages = [];
  let canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  let ctx = canvas.getContext('2d');
  let y = 0;

  const ink = '#0E1C2B', teal = '#0E7C86', brass = '#B5852A', mid = '#374251', muted = '#647285', light = '#EEF1F4';

  let pageCount = 0;
  const newPage = () => {
    if (y > 0) pages.push(canvas);
    canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    pageCount++;
    y = 0;
    // Running header on every page after the first — keeps a loose page identifiable
    if (pageCount > 1) {
      ctx.font = `bold 15px ${FONT_DISPLAY}`; ctx.fillStyle = teal;
      ctx.fillText('OATH RECORDS VAULT', MARGIN, 36);
      ctx.font = `15px ${FONT_BODY}`; ctx.fillStyle = muted;
      const nameLabel = patientName || 'Veteran Record';
      ctx.fillText(nameLabel, W - MARGIN - ctx.measureText(nameLabel).width, 36);
      ctx.strokeStyle = '#E1E6EB'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(MARGIN, 48); ctx.lineTo(W - MARGIN, 48); ctx.stroke();
      y = 72;
    }
  };

  const checkY = (needed) => { if (y + needed > H - 80) newPage(); };

  const text = (str, x, yy, opts = {}) => {
    ctx.font = `${opts.style || 'normal'} ${opts.weight || 'normal'} ${opts.size || 22}px ${opts.family || FONT_BODY}`;
    ctx.fillStyle = opts.color || ink;
    if (opts.maxWidth) {
      // Word wrap
      const words = str.split(' ');
      let line = '';
      let ly = yy;
      words.forEach(word => {
        const test = line + (line ? ' ' : '') + word;
        if (ctx.measureText(test).width > opts.maxWidth && line) {
          ctx.fillText(line, x, ly);
          line = word;
          ly += opts.lineH || LINE;
        } else { line = test; }
      });
      if (line) ctx.fillText(line, x, ly);
      return ly;
    }
    ctx.fillText(str, x, yy);
    return yy;
  };

  const pill = (label, x, yy, bg, fg, mono = false) => {
    ctx.font = mono ? `bold 16px ${FONT_MONO}` : `bold 17px ${FONT_BODY}`;
    const w = ctx.measureText(label).width + 20;
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(x, yy - 16, w, 24, 6); ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(label, x + 10, yy);
    return w;
  };

  const rule = (yy, color = '#E1E6EB') => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(MARGIN, yy); ctx.lineTo(W - MARGIN, yy); ctx.stroke();
  };

  // ---- PAGE 1 HEADER ----
  newPage();
  // Navy bar
  ctx.fillStyle = ink; ctx.fillRect(0, 0, W, 80);
  // Brass rule
  ctx.fillStyle = brass; ctx.fillRect(0, 80, W, 5);

  // Small drawn shield mark, echoing the live site's logo identity
  const shieldX = MARGIN, shieldY = 22, shieldW = 30, shieldH = 34;
  ctx.beginPath();
  ctx.moveTo(shieldX + shieldW / 2, shieldY);
  ctx.lineTo(shieldX + shieldW, shieldY + 8);
  ctx.lineTo(shieldX + shieldW, shieldY + 20);
  ctx.quadraticCurveTo(shieldX + shieldW, shieldY + shieldH, shieldX + shieldW / 2, shieldY + shieldH);
  ctx.quadraticCurveTo(shieldX, shieldY + shieldH, shieldX, shieldY + 20);
  ctx.lineTo(shieldX, shieldY + 8);
  ctx.closePath();
  ctx.fillStyle = brass; ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();

  text('OATH RECORDS VAULT', MARGIN + shieldW + 14, 48, { weight: 'bold', size: 28, color: '#ffffff', family: FONT_DISPLAY });
  text('HONORING THEIR OATH', MARGIN + shieldW + 14, 68, { size: 18, color: brass, family: FONT_BODY });
  const modeLabel = mode === 'veteran' ? 'VETERAN SUMMARY' : 'CLINICAL DETAIL';
  ctx.font = `bold 18px ${FONT_DISPLAY}`; ctx.fillStyle = brass;
  ctx.fillText(modeLabel, W - MARGIN - ctx.measureText(modeLabel).width, 48);

  y = 120;
  text(patientName || 'Veteran Record', MARGIN, y, { weight: 'bold', size: 38, color: ink, family: FONT_DISPLAY }); y += 44;
  if (identity.branch || identity.era) {
    text([identity.branch, identity.era].filter(Boolean).join(' · '), MARGIN, y, { size: 22, color: muted, family: FONT_BODY }); y += 30;
  }
  const metaLine = `${dob ? `DOB: ${formatNarrativeDate(dob)} (veteran-confirmed) · ` : ''}${stats.totalVisits} visits · ${stats.totalDocs} documents · Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  text(metaLine, MARGIN, y, { size: 19, color: muted, family: FONT_BODY }); y += 20;
  rule(y); y += 30;

  // ---- ENTRIES, grouped with a year header whenever the year changes ----
  let lastYear = null;
  entries.forEach((d, idx) => {
    const yr = d.date ? d.date.slice(0, 4) : null;
    const isNewYear = yr && yr !== lastYear;
    const entryHeight = mode === 'clinical' ? 200 : 140;

    // Reserve room for the header AND the entry that follows it together —
    // never let a year header land alone at the bottom of a page with its
    // first entry pushed to an otherwise-empty next page.
    if (isNewYear) {
      checkY(56 + entryHeight);
      lastYear = yr;
      // Year section header — brass pill + rule, gives the document real visual
      // structure (e.g. "2026" then everything under it, then "2025", etc.)
      y += 6;
      ctx.font = `bold 24px ${FONT_DISPLAY}`; ctx.fillStyle = '#ffffff';
      const labelW = ctx.measureText(yr).width + 28;
      ctx.fillStyle = brass;
      ctx.beginPath(); ctx.roundRect(MARGIN, y - 24, labelW, 34, 8); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(yr, MARGIN + 14, y);
      ctx.strokeStyle = '#E1E6EB'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(MARGIN + labelW + 14, y - 7); ctx.lineTo(W - MARGIN, y - 7); ctx.stroke();
      y += 32;
    } else {
      checkY(entryHeight);
    }

    // Date + visit type
    ctx.font = `bold 20px ${FONT_MONO}`; ctx.fillStyle = teal;
    ctx.fillText(formatNarrativeDate(d.date), MARGIN, y);
    if (d.visit_setting) {
      const dateW = ctx.measureText(formatNarrativeDate(d.date)).width;
      pill(d.visit_setting, MARGIN + dateW + 14, y, '#F7EFDC', brass);
    }
    y += 30;

    // Main issue
    const mainIssue = (d.what_happened && d.what_happened !== 'null' ? d.what_happened : null) || (d.document_type && d.document_type !== 'null' ? d.document_type : null) || 'Visit';
    ctx.font = `bold 24px ${FONT_DISPLAY}`; ctx.fillStyle = ink;
    const issueLines = [];
    let cur = '';
    mainIssue.split(' ').forEach(w => {
      const test = cur + (cur ? ' ' : '') + w;
      if (ctx.measureText(test).width > W - MARGIN * 2 && cur) { issueLines.push(cur); cur = w; }
      else cur = test;
    });
    if (cur) issueLines.push(cur);
    issueLines.forEach(l => { ctx.fillText(l, MARGIN, y); y += 30; });

    // Doctor + Location
    const docParts = [];
    if (d.provider) docParts.push(`Doctor: ${d.provider}`);
    if (d.facility || d.facility_location) docParts.push(`Location: ${[d.facility, d.facility_location].filter(Boolean).join(', ')}`);
    if (docParts.length > 0) {
      ctx.font = `20px ${FONT_BODY}`; ctx.fillStyle = muted;
      ctx.fillText(docParts.join('    '), MARGIN, y); y += 26;
    }

    // ICD-10-CM codes — labeled for the veteran
    const coded = (d.diagnoses || []).filter(x => x.icd10cm);
    if (coded.length > 0) {
      ctx.font = `bold 17px ${FONT_BODY}`; ctx.fillStyle = muted;
      ctx.fillText('ICD-10-CM:', MARGIN, y);
      let cx = MARGIN + ctx.measureText('ICD-10-CM:').width + 10;
      coded.forEach(x => {
        const label = x.description ? `${x.icd10cm} · ${x.description}` : x.icd10cm;
        cx += pill(label, cx, y, light, mid, true) + 8;
        if (cx > W - MARGIN - 100) { cx = MARGIN; y += 28; }
      });
      y += 28;
    }

    // Clinical only: full diagnoses + notes
    if (mode === 'clinical') {
      const allDx = (d.diagnoses || []);
      if (allDx.length > 0) {
        allDx.forEach(x => {
          checkY(30);
          ctx.font = `19px ${FONT_BODY}`; ctx.fillStyle = mid;
          ctx.fillText(`• ${x.description}${x.icd10cm ? ` (${x.icd10cm})` : ''}`, MARGIN + 12, y);
          y += 26;
        });
      }
      if (d.plain_summary) {
        checkY(40);
        ctx.font = `italic 19px ${FONT_BODY}`; ctx.fillStyle = muted;
        // Wrap notes
        const noteWords = d.plain_summary.split(' ');
        let noteLine = '';
        noteWords.forEach(w => {
          const test = noteLine + (noteLine ? ' ' : '') + w;
          if (ctx.measureText(test).width > W - MARGIN * 2 - 24 && noteLine) {
            ctx.fillText(noteLine, MARGIN + 12, y); y += SMALL_LINE; noteLine = w;
          } else noteLine = test;
        });
        if (noteLine) { ctx.fillText(noteLine, MARGIN + 12, y); y += SMALL_LINE; }
        y += 4;
      }
    }

    // Divider
    if (idx < entries.length - 1) {
      y += 10; checkY(20); rule(y, '#E1E6EB'); y += 20;
    }
  });

  // Footer on last page
  ctx.font = `17px ${FONT_BODY}`; ctx.fillStyle = muted;
  ctx.fillText('Oath Records Vault · Confidential health record · For authorized use only', MARGIN, H - 30);
  pages.push(canvas);

  // Build PDF
  const pdfBytes = canvasToPdfBytes(pages);
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (patientName || 'Record').replace(/[^a-z0-9]/gi, '_');
  a.href = url;
  a.download = `OathVault_${safeName}_${mode === 'veteran' ? 'Summary' : 'Clinical'}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
}


export default function App() {
  const [results, setResults] = useState([]);
  const [queue, setQueue] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState("narrative"); // narrative | raw
  const [search, setSearch] = useState("");
  const [doctorSearch, setDoctorSearch] = useState("");
  const [activeLocation, setActiveLocation] = useState(null);
  const [activeYear, setActiveYear] = useState(null);
  const [activeSetting, setActiveSetting] = useState(null);
  const [activeReason, setActiveReason] = useState(null);
  const [activeCondition, setActiveCondition] = useState(null); // selected condition key for the timeline
  const [condYear, setCondYear] = useState(null); // year filter within the selected condition
  const [medYear, setMedYear] = useState(null); // year filter for the medications panel
  const [alertsOpen, setAlertsOpen] = useState(false); // clinical alerts collapsed by default
  const [clarifyOpen, setClarifyOpen] = useState(false); // items needing clarification collapsed by default
  const [profileDOB, setProfileDOB] = useState(null); // veteran-confirmed date of birth (resolves DOB discrepancies)
  // conflict modal state — set when a newly extracted result raises an identity conflict
  const [conflictModal, setConflictModal] = useState(null);
  const [downloadModal, setDownloadModal] = useState(false);
  const [displayName, setDisplayName] = useState(null);
  const [nameHistory, setNameHistory] = useState([]);
  const fileInput = useRef(null);

  const addFiles = (fileList) => {
    const accepted = Array.from(fileList).filter(f =>
      ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"].includes(f.type));
    if (accepted.length < fileList.length) {
      alert("Some files were skipped — only PDF, PNG, JPEG, and WEBP are supported right now.");
    }
    setQueue(q => [...q, ...accepted]);
  };

  const processFile = async (file, existingId) => {
    const id = existingId || Math.random().toString(36).slice(2);
    // Determine if this is the first successfully completed record before this file lands.
    const isFirst = results.filter(r => r.status === "done").length === 0;
    const stages = getStages(isFirst);

    if (existingId) {
      setResults(r => r.map(x => x.id === id ? { ...x, status: "processing", error: null, truncated: false, stageIndex: 0, customStageLabel: null, stages } : x));
    } else {
      setResults(r => [...r, { id, filename: file.name, file, status: "processing", data: null, note: null, stageIndex: 0, stages }]);
    }

    // Advance through named stages on a timer; holds at the last stage until the real response lands.
    let stageIndex = 0;
    const stageTimer = setInterval(() => {
      if (stageIndex < stages.length - 1) {
        stageIndex += 1;
        setResults(r => r.map(x => x.id === id ? { ...x, stageIndex } : x));
      }
    }, STAGE_INTERVAL_MS);

    try {
      const isPdf = file.type === "application/pdf";

      if (isPdf && file.size > MAX_PDF_BYTES) {
        const err = new Error(
          `This PDF is ${humanSize(file.size)} — too large to send (limit ~${humanSize(MAX_PDF_BYTES)}).`
        );
        err.oversized = true;
        err.fileSize = file.size;
        throw err;
      }

      let base64, mediaType, resizeNote = null;
      if (!isPdf && file.size > MAX_IMAGE_BYTES) {
        const resized = await downscaleImage(file);
        base64 = resized.base64; mediaType = resized.mediaType;
        resizeNote = `Auto-resized from ${humanSize(file.size)} to ${humanSize(resized.bytes)} before sending.`;
      } else {
        base64 = await fileToBase64(file);
        mediaType = file.type;
      }

      setResults(r => r.map(x => x.id === id ? { ...x, note: resizeNote } : x));
      const data = await callClaude(base64, mediaType, prompt, (label) => {
        setResults(r => r.map(x => x.id === id ? { ...x, customStageLabel: label } : x));
      });
      clearInterval(stageTimer);

      // ---- Identity and medical-content validation ----
      // Run BEFORE committing to the vault so no bad data ever silently lands.

      // 1. No medical content at all — reject immediately.
      if (!hasMedicalContent(data)) {
        setResults(r => r.map(x => x.id === id ? {
          ...x, status: "error",
          error: "We couldn't find any medical information in this document. Please upload a real medical record.",
          noMedical: true,
        } : x));
        return;
      }

      // 2. Check the incoming name against what's already established in the vault.
      const incomingName = data.patient_name || null;
      setResults(prev => {
        const established = deriveIdentity(prev.filter(r => r.status === "done"));
        const establishedName = established.fullName;

        // Only block if first names are genuinely different — that's a different person.
        // Same first name + different last name = name change over time (marriage etc),
        // accept silently and let the veteran choose their display name later.
        if (incomingName && establishedName && !namesSamePerson(incomingName, establishedName)) {
          setConflictModal({
            type: "name_conflict",
            incoming: incomingName,
            established: establishedName,
            pendingId: id,
            pendingData: data,
          });
          return prev.map(x => x.id === id ? { ...x, status: "pending_review", data, stageIndex: EXTRACT_STAGES.length - 1, customStageLabel: null } : x);
        }

        // Commit normally — same person, possibly different last name.
        return prev.map(x => x.id === id ? { ...x, status: "done", data, stageIndex: EXTRACT_STAGES.length - 1, customStageLabel: null } : x);
      });

      // 3. After committing, collect all distinct names found across the vault.
      // If multiple names exist (name changes over time), show the name-chooser
      // once — after a short delay so the state above has settled.
      setTimeout(() => {
        setResults(prev => {
          const allNames = prev
            .filter(r => r.status === "done" && r.data?.patient_name)
            .map(r => r.data.patient_name);
          // Deduplicate names, normalizing for formatting differences.
          const seen = {};
          const distinctNames = [];
          allNames.forEach(n => {
            const norm = normalizeName(n);
            if (!seen[norm]) { seen[norm] = true; distinctNames.push(n); }
          });
          // If we have more than one distinct name and no display name chosen yet,
          // prompt the veteran to choose. Only show if queue is now empty (all done).
          const queueEmpty = prev.every(r => r.status === "done" || r.status === "error" || r.status === "pending_review");
          if (distinctNames.length > 1 && queueEmpty) {
            setNameHistory(distinctNames);
            // Only show the chooser if it hasn't already been addressed
            setConflictModal(m => m ? m : {
              type: "name_chooser",
              names: distinctNames,
            });
          }
          return prev;
        });
      }, 300);

    } catch (e) {
      clearInterval(stageTimer);
      setResults(r => r.map(x => x.id === id ? { ...x, status: "error", error: e.message, oversized: !!e.oversized, truncated: !!e.truncated } : x));
    }
  };

  const processQueue = async () => {
    if (queue.length === 0 || processing) return;
    setProcessing(true);
    const toProcess = [...queue];
    setQueue([]);
    for (const file of toProcess) {
      await processFile(file);
    }
    setProcessing(false);
  };

  const retryFile = (item) => {
    if (item.file) processFile(item.file, item.id);
  };

  // Conflict resolution handlers
  const handleDismissIncoming = () => {
    // Remove the pending_review item entirely — it never enters the vault.
    if (conflictModal?.pendingId) {
      setResults(r => r.filter(x => x.id !== conflictModal.pendingId));
    }
    setConflictModal(null);
  };

  const handleClearVaultAndAccept = () => {
    // Remove ALL current records and accept the incoming one as the new vault identity.
    if (conflictModal?.pendingId && conflictModal?.pendingData) {
      setResults([{
        id: conflictModal.pendingId,
        filename: conflictModal.pendingId,
        file: null,
        status: "done",
        data: conflictModal.pendingData,
        note: null,
        stageIndex: EXTRACT_STAGES.length - 1,
      }]);
    }
    setConflictModal(null);
  };

  const handleChooseName = (name) => {
    // The veteran has chosen what name appears on their record and printouts.
    // No records are removed — all documents stay in the vault regardless of
    // which name they were filed under. Only the display changes.
    setDisplayName(name);
    setConflictModal(null);
  };

  const removeResult = (id) => setResults(r => r.filter(x => x.id !== id));
  const clearAll = () => { setResults([]); setQueue([]); setDisplayName(null); setNameHistory([]); };

  const doneResults = results.filter(r => r.status === "done");
  const allEntries = useMemo(() => expandEvents(results), [results]);
  // Newest-first throughout: chronological summary, year browse, and the journey strip
  // all read most-recent-to-oldest. Undated entries sort to the end either way.
  const sortedEntries = useMemo(
    () => [...allEntries].sort((a, b) => (b.date || "0000").localeCompare(a.date || "0000")),
    [allEntries]
  );
  // Helper to check if an entry has enough real clinical content to show a veteran
  const hasVeteranContent = (e) => {
    const setting = e.visit_setting && e.visit_setting !== "null";
    const happened = e.what_happened && e.what_happened !== "null";
    const hasDx = (e.diagnoses || []).length > 0;
    const hasProvider = !!(e.provider && e.provider !== "null");
    const hasSummary = !!(e.plain_summary && e.plain_summary !== "null" && e.plain_summary.length > 10);
    // Show if we have at least one meaningful clinical field
    return setting || happened || hasDx || hasProvider || hasSummary;
  };

  const filteredResults = useMemo(() => {
    return sortedEntries.filter(e => {
      if (!hasVeteranContent(e)) return false;
      const matchesText = matchesSearch(e, search);
      const matchesDoctor = !doctorSearch.trim() ||
        (e.provider || "").toLowerCase().includes(doctorSearch.trim().toLowerCase());
      return matchesText && matchesDoctor;
    });
  }, [sortedEntries, search, doctorSearch]);
  // Year is the primary browse dimension; location optionally narrows within the selected year.
  const yearVisits = useMemo(() => {
    if (!activeYear) return [];
    return sortedEntries.filter(e =>
      hasVeteranContent(e) &&
      e.date && e.date.startsWith(activeYear) &&
      (!activeLocation || e.facility_location === activeLocation)
    );
  }, [sortedEntries, activeYear, activeLocation]);

  const yearLocationOptions = useMemo(() => {
    if (!activeYear) return [];
    const counts = {};
    sortedEntries
      .filter(e => e.date && e.date.startsWith(activeYear) && e.facility_location)
      .forEach(e => { counts[e.facility_location] = (counts[e.facility_location] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [sortedEntries, activeYear]);

  const settingVisits = useMemo(() => {
    if (!activeSetting) return [];
    return sortedEntries.filter(e =>
      hasVeteranContent(e) &&
      e.visit_setting === activeSetting && e.visit_setting !== "null"
    );
  }, [sortedEntries, activeSetting]);

  const reasonVisits = useMemo(() => {
    if (!activeReason) return [];
    return sortedEntries.filter(e =>
      hasVeteranContent(e) &&
      e.what_happened === activeReason && e.what_happened !== "null"
    );
  }, [sortedEntries, activeReason]);

  // Aggregate all medications across every completed document, newest-first.
  // Medications live at the document level in the extraction schema (not per-event),
  // so we pull from results directly rather than sortedEntries.
  const allMedications = useMemo(() => {
    const meds = [];
    results.filter(r => r.status === "done").forEach(r => {
      const d = r.data;
      if (d.medications && d.medications.length > 0) {
        // Use the document's own date, or its earliest event date, as the prescription date context.
        const sourceDate = d.date || (d.events && d.events.length > 0 ? d.events[0].date : null) || null;
        d.medications.forEach(m => {
          if (!m.name || m.name === "null") return;
          meds.push({
            name: m.name,
            dose: (m.dose && m.dose !== "null") ? m.dose : null,
            instructions: (m.instructions && m.instructions !== "null") ? m.instructions : null,
            sourceDate,
            sourceProvider: (d.provider && d.provider !== "null") ? d.provider : null,
            sourceFacility: (d.facility && d.facility !== "null") ? d.facility : null,
            sourceFilename: r.filename,
          });
        });
      }
    });
    return meds.sort((a, b) => (b.sourceDate || "0000").localeCompare(a.sourceDate || "0000"));
  }, [results]);

  // Aggregate all clinical flags across every completed document.
  // Flags capture clinically notable items the AI identified: allergies mentioned,
  // conflicting dates, illegible sections, medication interactions, etc.
  const allFlags = useMemo(() => {
    const flags = [];
    results.filter(r => r.status === "done").forEach(r => {
      const d = r.data;
      if (d.flags && d.flags.length > 0) {
        d.flags.forEach(f => {
          if (!f || f === "null") return;
          flags.push({
            text: f,
            sourceFilename: r.filename,
            sourceDate: d.date || null,
          });
        });
      }
    });
    return flags;
  }, [results]);

  // Split flags into two buckets:
  // 1. clinicalAlerts — genuinely clinical items (allergies, missing reports, abnormal findings)
  // 2. clarifications — record-keeping discrepancies the veteran can resolve themselves
  //    (DOB variations, name spellings, transcription errors, conflicting admin dates)
  // Classifier is keyword-based on the flag text — a data-quality issue, not a clinical one.
  const isClarificationFlag = (text) =>
    /date of birth|dob|birth date|birthdate|transcription error|spelled|spelling|name appears|appears variously|clerical|typo|inconsistent(ly)? (recorded|spelled|dated)|ssn|social security/i.test(text);

  const clinicalAlerts = useMemo(
    () => allFlags.filter(f => !isClarificationFlag(f.text)),
    [allFlags]
  );
  const clarifications = useMemo(
    () => allFlags.filter(f => isClarificationFlag(f.text)),
    [allFlags]
  );
  // Whether any clarification mentions a DOB discrepancy — if so, we offer the DOB resolver input
  const hasDOBDiscrepancy = useMemo(
    () => clarifications.some(f => /date of birth|dob|birth date|birthdate/i.test(f.text)),
    [clarifications]
  );

  // Aggregate all unique conditions/diagnoses across every entry, ranked by frequency.
  // Each entry in the map carries the list of timeline entries where that condition appears,
  // deduped by entry id — used to power the condition timeline panel.
  const allConditions = useMemo(() => {
    const condMap = {};
    sortedEntries.forEach(e => {
      (e.diagnoses || []).forEach(dx => {
        if (!dx.description || dx.description === "null") return;
        const key = dx.description.toLowerCase().trim();
        if (!condMap[key]) {
          condMap[key] = { label: dx.description, icd10cm: null, count: 0, entryIds: new Set(), entries: [] };
        }
        // Prefer any confident ICD code we find for this condition
        if (dx.icd10cm && dx.icd10cm !== "null" && !condMap[key].icd10cm) {
          condMap[key].icd10cm = dx.icd10cm;
        }
        condMap[key].count++;
        // Deduplicate entries by id — a condition could appear in multiple dx rows in the same visit
        if (!condMap[key].entryIds.has(e.id)) {
          condMap[key].entryIds.add(e.id);
          condMap[key].entries.push(e);
        }
      });
    });
    return Object.values(condMap)
      .filter(c => c.count > 0)
      .sort((a, b) => b.count - a.count)
      .map(c => ({ ...c, entryIds: undefined })); // drop the Set before returning
  }, [sortedEntries]);
  const stats = useMemo(() => computeStats(results), [results]);
  const identity = useMemo(() => deriveIdentity(results), [results]);
  const doneCount = results.filter(r => r.status === "done").length;
  const pendingResults = results.filter(r => r.status !== "done" && r.status !== "pending_review");

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#F4F6F8", minHeight: "100vh", color: "#16222F" }}>
      <ConflictModal
        modal={conflictModal}
        onDismissIncoming={handleDismissIncoming}
        onClearVaultAndAccept={handleClearVaultAndAccept}
        onChooseName={handleChooseName}
        onClose={() => setConflictModal(null)}
      />
      {downloadModal && (
        <DownloadModal
          onDownload={async (mode) => {
            const entries = filteredResults.length > 0 ? filteredResults : sortedEntries;
            const name = displayName || identity.fullName || "Veteran";
            await generatePDF(entries, identity, stats, name, mode, profileDOB);
          }}
          onClose={() => setDownloadModal(false)}
        />
      )}
      <SideNav visible={doneResults.length > 0} />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
        *{ box-sizing:border-box; }
        button{ cursor:pointer; font-family:inherit; }
        .disp{ font-family:'Space Grotesk',sans-serif; }
        .mono{ font-family:'IBM Plex Mono',monospace; }
        .dz{ border:2px dashed #C7D2DD; border-radius:14px; background:#fff; transition:border-color .15s, background .15s; }
        .dz.drag{ border-color:#0E7C86; background:#E9F4F4; }
        .spin{ animation:spin 1s linear infinite; }
        @keyframes spin{ to{ transform:rotate(360deg); } }
        textarea{ font-family:'SF Mono',monospace; }
        .oath-card{ background:#fff; border:1px solid #E1E6EB; border-radius:14px; }
        .progress-track{ height:7px; border-radius:999px; background:#EEF1F4; overflow:hidden; position:relative; }
        .progress-fill{
          height:100%; border-radius:999px; background:linear-gradient(90deg,#0E7C86,#1B9DA8);
          transition:width .7s cubic-bezier(.3,.7,.4,1); position:relative; overflow:hidden;
        }
        .progress-fill::after{
          content:""; position:absolute; inset:0;
          background:linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent);
          width:60%; animation:shimmer 1.4s ease-in-out infinite;
        }
        @keyframes shimmer{
          0%{ transform:translateX(-120%); }
          100%{ transform:translateX(220%); }
        }
        .progress-fill.indeterminate{
          width:40% !important; position:absolute; animation:indeterminate 1.3s ease-in-out infinite;
        }
        @keyframes indeterminate{
          0%{ left:-40%; }
          100%{ left:100%; }
        }
        @media (prefers-reduced-motion: reduce){
          .progress-fill::after{ animation:none; }
          .progress-fill{ transition:none; }
          .progress-fill.indeterminate{ animation:none; left:0; width:100% !important; }
        }
        .tab-btn{ display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; padding:8px 14px; border-radius:9px; color:#5C6773; }
        .tab-btn[data-on="true"]{ background:#0E1C2B; color:#fff; }
        .stat-tile{ background:#fff; border:1px solid #E1E6EB; border-radius:12px; padding:14px 16px; }
        mark{ background:#FFE8A3; color:#16222F; border-radius:3px; padding:0 1px; }
        @media print{
          .no-print{ display:none !important; }
          body{ background:#fff; }
          @page{ margin: 0.6in; }
          .oath-card{ box-shadow:none !important; border:1px solid #E1E6EB !important; break-inside:avoid; }
          a[href]:after{ content:""; }
        }
      `}</style>

      {/* Branded header */}
      <div style={{ background: "#0E1C2B", padding: "14px 24px" }} className="no-print">
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>

          {/* Oath Vault logo mark — SVG recreation of the uploaded badge */}
          <svg width="42" height="42" viewBox="0 0 100 100" style={{ flex: "none" }}>
            {/* Outer ring */}
            <circle cx="50" cy="50" r="47" fill="#1B2A4A" />
            <circle cx="50" cy="50" r="47" fill="none" stroke="#B8973A" strokeWidth="3" />
            <circle cx="50" cy="50" r="40" fill="none" stroke="#B8973A" strokeWidth="1" />
            {/* Gold stars */}
            {[0, 60, 120, 240, 300].map((deg, i) => {
              const r = 43; const rad = (deg - 90) * Math.PI / 180;
              const x = 50 + r * Math.cos(rad); const y = 50 + r * Math.sin(rad);
              return <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#B8973A">★</text>;
            })}
            {/* Shield */}
            <path d="M50 18 L68 26 L68 52 Q68 68 50 76 Q32 68 32 52 L32 26 Z" fill="#fff" stroke="#1B2A4A" strokeWidth="2" />
            {/* Shield inner border */}
            <path d="M50 22 L64 29 L64 51 Q64 65 50 72 Q36 65 36 51 L36 29 Z" fill="none" stroke="#1B2A4A" strokeWidth="1.5" />
            {/* Caduceus staff */}
            <line x1="50" y1="24" x2="50" y2="72" stroke="#1B2A4A" strokeWidth="2.5" strokeLinecap="round" />
            {/* Caduceus wings */}
            <path d="M50 32 Q42 28 40 34 Q42 36 50 34" fill="#B8973A" />
            <path d="M50 32 Q58 28 60 34 Q58 36 50 34" fill="#B8973A" />
            {/* Serpent left */}
            <path d="M50 36 Q42 40 44 46 Q46 50 50 50 Q44 52 43 58 Q44 64 50 66"
              fill="none" stroke="#B8973A" strokeWidth="2" strokeLinecap="round" />
            {/* Serpent right */}
            <path d="M50 36 Q58 40 56 46 Q54 50 50 50 Q56 52 57 58 Q56 64 50 66"
              fill="none" stroke="#8899AA" strokeWidth="2" strokeLinecap="round" />
            {/* Top orb */}
            <circle cx="50" cy="24" r="3" fill="#1B2A4A" />
            {/* Circular text arc */}
            <defs>
              <path id="arc" d="M 12,50 A 38,38 0 0,1 88,50" />
            </defs>
            <text fontSize="7.5" fill="#1B2A4A" fontWeight="700" letterSpacing="1.5" fontFamily="Georgia, serif">
              <textPath href="#arc" startOffset="50%" textAnchor="middle">HONORING THEIR OATH</textPath>
            </text>
          </svg>

          <div>
            <div className="disp" style={{ color: "#fff", fontWeight: 700, fontSize: 18, lineHeight: 1, letterSpacing: ".04em" }}>OATH RECORDS VAULT</div>
            <div style={{ fontSize: 9.5, color: "#B8973A", letterSpacing: ".12em", marginTop: 3, fontWeight: 600 }}>HONORING THEIR OATH</div>
          </div>

          {identity.fullName && (
            <>
              <span style={{ width: 1, height: 28, background: "rgba(255,255,255,.12)", flex: "none" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{
                  width: 30, height: 30, borderRadius: 999, background: "linear-gradient(150deg,#2C4A63,#0E7C86)",
                  display: "flex", alignItems: "center", justifyContent: "center", flex: "none",
                }} className="disp">
                  <span style={{ color: "#fff", fontWeight: 700, fontSize: 11 }}>
                    {(displayName || identity.fullName || "").split(" ").map(w => w[0]).join("").slice(0, 2)}
                  </span>
                </span>
                <div>
                  <div style={{ color: "#fff", fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>{displayName || identity.fullName}</div>
                  {(identity.branch || identity.era) && (
                    <div style={{ fontSize: 10.5, color: "#8FA3B8" }}>
                      {[identity.branch, identity.era].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {results.length > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#9FB1C7", display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={13} color="#5FBF8F" /> {doneCount} record{doneCount === 1 ? "" : "s"} in your vault
            </span>
          )}
        </div>
      </div>
      <div style={{ height: 3, background: "#B5852A" }} className="no-print" />

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 20px 80px" }}>

        {/* Welcome (only before anything's been added) */}
        {results.length === 0 && queue.length === 0 && (
          <div style={{ marginBottom: 22 }} className="no-print">
            <h1 className="disp" style={{ fontSize: 27, fontWeight: 700, margin: 0 }}>Welcome to the Oath Records Vault.</h1>
            <p style={{ fontSize: 14, color: "#5C6773", marginTop: 10, lineHeight: 1.8, maxWidth: 640 }}>
              We're here to help streamline your healthcare information by consolidating your medical records. To get started, upload your documents as a{" "}
              <span style={{ color: "#0E7C86", fontWeight: 700 }}>PDF</span>,{" "}
              <span style={{ color: "#0E7C86", fontWeight: 700 }}>PNG</span>,{" "}
              <span style={{ color: "#0E7C86", fontWeight: 700 }}>JPEG</span>, or{" "}
              <span style={{ color: "#0E7C86", fontWeight: 700 }}>WEBP</span> file —{" "}
              <strong>the Oath Records Vault</strong> will identify the owner, consolidate everything into a single, chronological record that you can search, print, or share. We're committed to making this process as smooth and efficient as possible for you. Let's get started on bringing your health information together!
            </p>
          </div>
        )}

        {/* Upload zone */}
        <div
          className={"dz" + (dragOver ? " drag" : "")}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => fileInput.current?.click()}
          style={{ padding: "26px 20px", textAlign: "center", cursor: "pointer", marginBottom: 14 }}
        >
          <input ref={fileInput} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp"
            style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
          <Upload size={22} color="#0E7C86" />
          <div style={{ fontWeight: 600, fontSize: 14, marginTop: 8 }}>Drop documents or click to select</div>
          <div style={{ fontSize: 12, color: "#8A95A1", marginTop: 4 }}>
            PDF, PNG, JPEG, WEBP · multiple files OK · PDFs up to {humanSize(MAX_PDF_BYTES)} (images are auto-resized)
          </div>
        </div>

        {/* Queue */}
        {queue.length > 0 && (
          <div style={{ marginBottom: 14 }} className="no-print">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
              {queue.map((f, i) => {
                const tooBig = f.type === "application/pdf" && f.size > MAX_PDF_BYTES;
                return (
                  <span key={i} style={{
                    fontSize: 12, background: tooBig ? "#FDF4F3" : "#fff", border: "1px solid " + (tooBig ? "#F0C4C0" : "#DDE2E7"),
                    color: tooBig ? "#B4302A" : "#1B1B1B", padding: "5px 10px", borderRadius: 999, display: "flex", alignItems: "center", gap: 6,
                  }}>
                    {tooBig && <AlertTriangle size={11} />}
                    {f.name} <span style={{ color: "#8A95A1" }}>· {humanSize(f.size)}</span>
                    <button onClick={() => setQueue(q => q.filter((_, qi) => qi !== i))} style={{ color: "#8A95A1", display: "flex" }}>
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
              <button onClick={processQueue} disabled={processing} style={{
                marginLeft: "auto", background: "#0E7C86", color: "#fff", border: "none", borderRadius: 9,
                padding: "9px 16px", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 7,
                opacity: processing ? .6 : 1,
              }}>
                {processing ? <><Loader size={14} className="spin" /> Adding…</> : <>Add {queue.length} record{queue.length === 1 ? "" : "s"} to Vault</>}
              </button>
            </div>

            {queue.some(f => f.type === "application/pdf" && f.size > MAX_PDF_BYTES) && (
              <div style={{ fontSize: 12, color: "#9A6B00", background: "#FFF8E8", border: "1px solid #F0DDA0", borderRadius: 8, padding: "8px 12px" }}>
                One or more PDFs are over the {humanSize(MAX_PDF_BYTES)} limit and will fail. Compress with{" "}
                <a href="https://www.adobe.com/acrobat/online/compress-pdf.html" target="_blank" rel="noopener noreferrer" style={{ color: "#0E7C86", fontWeight: 700, textDecoration: "underline" }}>
                  Adobe's PDF compressor ↗
                </a>, then re-upload.
              </div>
            )}
          </div>
        )}

        {/* Pending/processing items */}
        {pendingResults.length > 0 && (
          <div className="no-print" style={{ marginBottom: 14 }}>
            {pendingResults.map(item => {
              const stages = item.stages || EXTRACT_STAGES;
              const stage = stages[item.stageIndex ?? 0] || stages[stages.length - 1];
              return item.status === "processing" ? (
                <div key={item.id} className="oath-card" style={{ padding: 16, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
                    <Loader size={15} className="spin" color="#0E7C86" />
                    <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.filename}
                    </span>
                    {!item.customStageLabel && (
                      <span className="mono" style={{ fontSize: 11.5, color: "#0E7C86", fontWeight: 700 }}>
                        {stage.pct}%
                      </span>
                    )}
                  </div>
                  <div className="progress-track">
                    <div
                      className={"progress-fill" + (item.customStageLabel ? " indeterminate" : "")}
                      style={item.customStageLabel ? undefined : { width: `${stage.pct}%` }}
                    />
                  </div>
                  <div style={{ fontSize: 11.5, color: "#5C6773", marginTop: 7 }}>
                    {item.customStageLabel || `${stage.label}…`}
                  </div>
                  {item.note && <div style={{ fontSize: 11.5, color: "#9A6B00", marginTop: 4 }}>{item.note}</div>}
                </div>
              ) : (
                <ResultCard key={item.id} item={item} onRemove={() => removeResult(item.id)} onRetry={() => retryFile(item)} />
              );
            })}
          </div>
        )}

        {/* ============ DASHBOARD ============ */}
        {doneResults.length > 0 && (
          <>
            {identity.fullName && (
              <div className="no-print" style={{
                display: "flex", flexDirection: "column", gap: 6, marginBottom: 18, padding: "12px 16px",
                background: "#E9F4F4", border: "1px solid #BFE0E1", borderRadius: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Check size={15} color="#0E7C86" />
                  <span style={{ fontSize: 13, color: "#16222F" }}>
                    Showing as <strong>{displayName || identity.fullName}</strong>
                    {(identity.branch || identity.era) && <> — {[identity.branch, identity.era].filter(Boolean).join(" · ")}</>}.
                  </span>
                  {nameHistory.length > 1 && (
                    <button
                      onClick={() => setConflictModal({ type: "name_chooser", names: nameHistory })}
                      style={{ fontSize: 12, color: "#0E7C86", fontWeight: 700, textDecoration: "underline", marginLeft: "auto", background: "none", border: "none", cursor: "pointer" }}
                    >
                      Change name
                    </button>
                  )}
                </div>
                {nameHistory.length > 1 && (
                  <div style={{ fontSize: 12, color: "#42505E", paddingLeft: 25 }}>
                    Records found under: {nameHistory.join(" · ")} — all records are included regardless of which name appears on the document.
                  </div>
                )}
              </div>
            )}

            {/* Clinical Alerts — collapsed by default so it reads as informational, not an error.
                Slim header row with a count; click to expand the full list. */}
            {clinicalAlerts.length > 0 && (
              <div className="no-print" style={{
                marginBottom: 10, background: "#FFFDF7", border: "1px solid #EFE3C0", borderRadius: 10, overflow: "hidden",
              }}>
                <button
                  onClick={() => setAlertsOpen(o => !o)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "11px 14px",
                    background: "none", border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <AlertTriangle size={14} color="#B5852A" style={{ flex: "none" }} />
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".04em", color: "#B5852A" }}>
                    CLINICAL NOTES
                  </span>
                  <span style={{ fontSize: 12, color: "#8A95A1" }}>
                    {clinicalAlerts.length} item{clinicalAlerts.length === 1 ? "" : "s"} your provider may want to know about
                  </span>
                  {alertsOpen
                    ? <ChevronUp size={15} color="#8A95A1" style={{ marginLeft: "auto", flex: "none" }} />
                    : <ChevronDown size={15} color="#8A95A1" style={{ marginLeft: "auto", flex: "none" }} />}
                </button>
                {alertsOpen && (
                  <div style={{ padding: "2px 14px 13px 37px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {clinicalAlerts.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                        <span style={{ width: 5, height: 5, borderRadius: 999, background: "#B5852A", flex: "none", marginTop: 7 }} />
                        <span style={{ fontSize: 12.5, color: "#5C3D00", flex: 1, lineHeight: 1.55 }}>{f.text}</span>
                        <span style={{ fontSize: 10.5, color: "#B5852A", fontWeight: 600, whiteSpace: "nowrap", marginTop: 2, flex: "none" }}>
                          {f.sourceFilename.length > 24 ? f.sourceFilename.slice(0, 22) + "…" : f.sourceFilename}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Items Needing Clarification — record-keeping discrepancies, not clinical issues.
                Collapsed by default. If a DOB discrepancy exists, the veteran can enter their
                correct DOB — it's stored on their profile and appears on PDF printouts,
                same pattern as the display-name chooser. */}
            {clarifications.length > 0 && (
              <div className="no-print" style={{
                marginBottom: 18, background: "#FBFCFD", border: "1px solid #DDE5EC", borderRadius: 10, overflow: "hidden",
              }}>
                <button
                  onClick={() => setClarifyOpen(o => !o)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "11px 14px",
                    background: "none", border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <FileText size={14} color="#5C7EA3" style={{ flex: "none" }} />
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".04em", color: "#5C7EA3" }}>
                    ITEMS NEEDING CLARIFICATION
                  </span>
                  <span style={{ fontSize: 12, color: "#8A95A1" }}>
                    {clarifications.length} record-keeping detail{clarifications.length === 1 ? "" : "s"} you can confirm
                  </span>
                  {profileDOB && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#1E7B3C", background: "#E3F3E8", padding: "2px 9px", borderRadius: 999, flex: "none" }}>
                      DOB confirmed
                    </span>
                  )}
                  {clarifyOpen
                    ? <ChevronUp size={15} color="#8A95A1" style={{ marginLeft: "auto", flex: "none" }} />
                    : <ChevronDown size={15} color="#8A95A1" style={{ marginLeft: "auto", flex: "none" }} />}
                </button>
                {clarifyOpen && (
                  <div style={{ padding: "2px 14px 14px 37px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: hasDOBDiscrepancy ? 14 : 0 }}>
                      {clarifications.map((f, i) => (
                        <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                          <span style={{ width: 5, height: 5, borderRadius: 999, background: "#5C7EA3", flex: "none", marginTop: 7 }} />
                          <span style={{ fontSize: 12.5, color: "#42505E", flex: 1, lineHeight: 1.55 }}>{f.text}</span>
                          <span style={{ fontSize: 10.5, color: "#8A95A1", fontWeight: 600, whiteSpace: "nowrap", marginTop: 2, flex: "none" }}>
                            {f.sourceFilename.length > 24 ? f.sourceFilename.slice(0, 22) + "…" : f.sourceFilename}
                          </span>
                        </div>
                      ))}
                    </div>
                    {hasDOBDiscrepancy && (
                      <div style={{ borderTop: "1px solid #E8EDF2", paddingTop: 12 }}>
                        <div style={{ fontSize: 12, color: "#42505E", marginBottom: 7, fontWeight: 600 }}>
                          Confirm your date of birth — it will appear on your profile and printed record:
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            type="date"
                            value={profileDOB || ""}
                            onChange={e => setProfileDOB(e.target.value || null)}
                            style={{
                              fontSize: 13, padding: "8px 12px", borderRadius: 8,
                              border: "1px solid #C9D4DD", outline: "none", background: "#fff",
                              fontFamily: "'IBM Plex Mono', monospace", color: "#16222F",
                            }}
                          />
                          {profileDOB && (
                            <>
                              <span style={{ fontSize: 12, color: "#1E7B3C", display: "flex", alignItems: "center", gap: 5 }}>
                                <Check size={13} /> Saved as {formatNarrativeDate(profileDOB)}
                              </span>
                              <button
                                onClick={() => setProfileDOB(null)}
                                style={{ fontSize: 11.5, color: "#8A95A1", textDecoration: "underline", border: "none", background: "none", cursor: "pointer" }}
                              >
                                Clear
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Stat tiles */}
            <div id="section-overview" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 22 }} className="no-print">
              <div className="stat-tile">
                <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>{stats.totalDocs}</div>
                <div style={{ fontSize: 11.5, color: "#8A95A1", marginTop: 2 }}>Records in vault</div>
              </div>
              <div className="stat-tile">
                <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>{stats.totalVisits}</div>
                <div style={{ fontSize: 11.5, color: "#8A95A1", marginTop: 2 }}>Visits</div>
              </div>
              <div className="stat-tile">
                <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>
                  {stats.earliest ? formatNarrativeDate(stats.earliest) : "—"}
                </div>
                <div style={{ fontSize: 11.5, color: "#8A95A1", marginTop: 2 }}>Earliest record</div>
              </div>
              <div className="stat-tile">
                <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>
                  {stats.latest ? formatNarrativeDate(stats.latest) : "—"}
                </div>
                <div style={{ fontSize: 11.5, color: "#8A95A1", marginTop: 2 }}>Latest record</div>
              </div>
              {allMedications.length > 0 && (
                <div className="stat-tile">
                  <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>{allMedications.length}</div>
                  <div style={{ fontSize: 11.5, color: "#8A95A1", marginTop: 2 }}>Prescriptions found</div>
                </div>
              )}
            </div>

            {/* Browse by year, then optionally narrow by location */}
            {stats.yearCounts.length > 0 && (
              <div id="section-timeline" className="oath-card no-print" style={{ padding: 16, marginBottom: 22 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "#8A95A1", marginBottom: 10 }}>
                  BROWSE BY YEAR
                </div>
                <YearTimeline
                  yearCounts={stats.yearCounts}
                  activeYear={activeYear}
                  onSelectYear={(year) => {
                    setActiveYear(activeYear === year ? null : year);
                    setActiveLocation(null);
                  }}
                />

                {activeYear && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #EEF1F4" }}>
                    {/* Locations present within the selected year, as a secondary narrowing step */}
                    {yearLocationOptions.length > 1 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
                        <span style={{ fontSize: 11.5, color: "#8A95A1", marginRight: 2 }}>Narrow by where:</span>
                        {yearLocationOptions.map(([loc, count]) => (
                          <button
                            key={loc}
                            onClick={() => setActiveLocation(activeLocation === loc ? null : loc)}
                            style={{
                              display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600,
                              padding: "5px 10px", borderRadius: 999,
                              border: "1.5px solid " + (activeLocation === loc ? "#0E7C86" : "#DDE2E7"),
                              background: activeLocation === loc ? "#0E7C86" : "#fff",
                              color: activeLocation === loc ? "#fff" : "#16222F",
                            }}
                          >
                            <MapPin size={10} /> {loc} <span className="mono" style={{ opacity: .8 }}>{count}×</span>
                          </button>
                        ))}
                        {activeLocation && (
                          <button onClick={() => setActiveLocation(null)} style={{ fontSize: 11.5, color: "#8A95A1", textDecoration: "underline" }}>
                            Clear
                          </button>
                        )}
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        Visits in {activeYear}{activeLocation ? ` — ${activeLocation}` : ""}
                      </span>
                      <span className="mono" style={{ fontSize: 11.5, color: "#8A95A1" }}>
                        {yearVisits.length} visit{yearVisits.length === 1 ? "" : "s"}
                      </span>
                      <button onClick={() => { setActiveYear(null); setActiveLocation(null); }} style={{ marginLeft: "auto", fontSize: 12, color: "#8A95A1", display: "flex", alignItems: "center", gap: 4 }}>
                        <X size={13} /> Close
                      </button>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {yearVisits.map(d => <VisitRow key={d.id} d={d} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Visits + Reason for Visit — stacked vertically, each with split-panel (left: selector, right: scrollable results) */}
            <div id="section-visits" style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 22 }} className="no-print">

              {/* VISITS card */}
              <div className="oath-card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEF1F4" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "#8A95A1" }}>VISITS</span>
                  {activeSetting && <span style={{ fontSize: 11.5, color: "#0E7C86", marginLeft: 8 }}>· {activeSetting}</span>}
                </div>
                <div style={{ display: "flex", minHeight: 200, maxHeight: 420 }}>
                  {/* Left: selector list */}
                  <div style={{ flex: "0 0 auto", width: activeSetting ? "30%" : "100%", padding: "8px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", borderRight: activeSetting ? "1px solid #EEF1F4" : "none", transition: "width .2s" }}>
                    {stats.settingCounts.length === 0 && <span style={{ fontSize: 12.5, color: "#8A95A1", padding: "8px" }}>—</span>}
                    {stats.settingCounts.map(([setting, count]) => (
                      <button
                        key={setting}
                        onClick={() => setActiveSetting(activeSetting === setting ? null : setting)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8,
                          background: activeSetting === setting ? "#E9F4F4" : "transparent", textAlign: "left", width: "100%",
                        }}
                      >
                        <span style={{ fontSize: 12.5, flex: 1, fontWeight: activeSetting === setting ? 700 : 400, color: activeSetting === setting ? "#0E7C86" : "#16222F" }}>
                          {setting}
                        </span>
                        <div style={{ height: 5, width: activeSetting ? 36 : 60, background: "#EEF1F4", borderRadius: 999, overflow: "hidden", flex: "none" }}>
                          <div style={{ height: "100%", width: `${Math.min(100, (count / stats.totalVisits) * 100)}%`, background: "#0E7C86" }} />
                        </div>
                        <span className="mono" style={{ fontSize: 11, color: "#5C6773", flex: "none" }}>{count}</span>
                      </button>
                    ))}
                  </div>
                  {/* Right: scrollable results */}
                  {activeSetting && (
                    <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
                      {settingVisits.length === 0
                        ? <span style={{ fontSize: 12.5, color: "#8A95A1", padding: 4 }}>No visits found.</span>
                        : settingVisits.map(d => <VisitRow key={d.id} d={d} />)
                      }
                    </div>
                  )}
                </div>
              </div>

              {/* REASON FOR VISIT card */}
              <div className="oath-card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEF1F4" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "#8A95A1" }}>REASON FOR VISIT</span>
                  {activeReason && <span style={{ fontSize: 11.5, color: "#0E7C86", marginLeft: 8 }}>· {activeReason}</span>}
                </div>
                <div style={{ display: "flex", minHeight: 200, maxHeight: 420 }}>
                  {/* Left: selector list */}
                  <div style={{ flex: "0 0 auto", width: activeReason ? "30%" : "100%", padding: "8px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", borderRight: activeReason ? "1px solid #EEF1F4" : "none", transition: "width .2s" }}>
                    {stats.whatHappenedCounts.length === 0 && <span style={{ fontSize: 12.5, color: "#8A95A1", padding: "8px" }}>—</span>}
                    {stats.whatHappenedCounts.map(([reason, count]) => (
                      <button
                        key={reason}
                        onClick={() => setActiveReason(activeReason === reason ? null : reason)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8,
                          background: activeReason === reason ? "#E9F4F4" : "transparent", textAlign: "left", width: "100%",
                        }}
                      >
                        <span style={{ fontSize: 12.5, flex: 1, fontWeight: activeReason === reason ? 700 : 400, color: activeReason === reason ? "#0E7C86" : "#16222F" }}>
                          {reason}
                        </span>
                        <Badge>{count}×</Badge>
                      </button>
                    ))}
                  </div>
                  {/* Right: scrollable results */}
                  {activeReason && (
                    <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
                      {reasonVisits.length === 0
                        ? <span style={{ fontSize: 12.5, color: "#8A95A1", padding: 4 }}>No visits found.</span>
                        : reasonVisits.map(d => <VisitRow key={d.id} d={d} />)
                      }
                    </div>
                  )}
                </div>
              </div>

            </div>

            {/* Medications — browse by year, same concept as the year timeline.
                Year chips across the top; click a year to see what was prescribed then.
                Compact rows keep the panel scannable. */}
            {allMedications.length > 0 && (() => {
              // Group medications by year of their source date
              const medYearCounts = {};
              allMedications.forEach(m => {
                const yr = m.sourceDate && /^\d{4}/.test(m.sourceDate) ? m.sourceDate.slice(0, 4) : "Undated";
                medYearCounts[yr] = (medYearCounts[yr] || 0) + 1;
              });
              const medYears = Object.keys(medYearCounts).sort((a, b) => b.localeCompare(a)); // newest first
              const shownMeds = medYear
                ? allMedications.filter(m => {
                    const yr = m.sourceDate && /^\d{4}/.test(m.sourceDate) ? m.sourceDate.slice(0, 4) : "Undated";
                    return yr === medYear;
                  })
                : [];

              return (
                <div id="section-medications" className="oath-card no-print" style={{ marginBottom: 22 }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEF1F4", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "#8A95A1" }}>MEDICATIONS</span>
                    <span className="mono" style={{ fontSize: 11.5, color: "#8A95A1" }}>
                      {allMedications.length} prescription{allMedications.length === 1 ? "" : "s"} · select a year
                    </span>
                    {medYear && (
                      <button
                        onClick={() => setMedYear(null)}
                        style={{ marginLeft: "auto", fontSize: 12, color: "#8A95A1", display: "flex", alignItems: "center", gap: 4, border: "none", background: "none", cursor: "pointer" }}
                      >
                        <X size={13} /> Close
                      </button>
                    )}
                  </div>

                  {/* Year chips — brass pill styling to echo the year timeline */}
                  <div style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 6, borderBottom: medYear ? "1px solid #EEF1F4" : "none" }}>
                    {medYears.map(yr => {
                      const isActive = medYear === yr;
                      return (
                        <button
                          key={yr}
                          onClick={() => setMedYear(isActive ? null : yr)}
                          className="disp"
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 7,
                            padding: "5px 13px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                            background: isActive ? "#B5852A" : "#F7EFDC",
                            color: isActive ? "#fff" : "#B5852A",
                            border: "none", transition: "background .12s, color .12s", cursor: "pointer",
                          }}
                        >
                          {yr}
                          <span style={{
                            fontSize: 10.5, fontWeight: 700,
                            background: isActive ? "rgba(255,255,255,.2)" : "rgba(181,133,42,.15)",
                            padding: "1px 7px", borderRadius: 999,
                          }}>{medYearCounts[yr]}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Medications for the selected year — compact rows */}
                  {medYear && (
                    <div style={{ maxHeight: 320, overflowY: "auto" }}>
                      {shownMeds.map((m, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "baseline", gap: 12, padding: "9px 16px",
                          borderBottom: i < shownMeds.length - 1 ? "1px solid #F4F6F8" : "none",
                          flexWrap: "wrap",
                        }}>
                          <span className="mono" style={{ fontSize: 11, color: "#0E7C86", fontWeight: 600, flex: "none", width: 86 }}>
                            {m.sourceDate ? formatNarrativeDate(m.sourceDate) : "Undated"}
                          </span>
                          <span style={{ fontWeight: 700, fontSize: 13, color: "#16222F" }}>{m.name}</span>
                          {m.dose && <span style={{ fontSize: 12, color: "#5C6773" }}>{m.dose}</span>}
                          {m.instructions && <span style={{ fontSize: 12, color: "#8A95A1" }}>{m.instructions}</span>}
                          {m.sourceProvider && (
                            <span style={{ fontSize: 11.5, color: "#8A95A1", marginLeft: "auto" }}>
                              Dr. {m.sourceProvider.replace(/^Dr\.?\s*/i, "")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Condition Timeline — pick any diagnosis and see its full history across time.
                Tells the clinical story of a chronic condition: when it was first noted,
                how it was managed, every encounter where it appears. Oldest-to-newest
                so the arc reads naturally forward in time. */}
            {allConditions.length > 0 && (
              <div id="section-conditions" className="oath-card no-print" style={{ marginBottom: 22 }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEF1F4", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "#8A95A1" }}>CONDITION TIMELINE</span>
                  <span className="mono" style={{ fontSize: 11.5, color: "#8A95A1" }}>
                    {allConditions.length} condition{allConditions.length === 1 ? "" : "s"} found · select one to trace its history
                  </span>
                  {activeCondition && (
                    <button
                      onClick={() => { setActiveCondition(null); setCondYear(null); }}
                      style={{ marginLeft: "auto", fontSize: 12, color: "#8A95A1", display: "flex", alignItems: "center", gap: 4, border: "none", background: "none", cursor: "pointer" }}
                    >
                      <X size={13} /> Clear
                    </button>
                  )}
                </div>

                {/* Condition pill selector — all unique conditions, ranked by frequency */}
                <div style={{
                  padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 6,
                  borderBottom: activeCondition ? "1px solid #EEF1F4" : "none",
                  maxHeight: 160, overflowY: "auto",
                }}>
                  {allConditions.map(c => {
                    const key = c.label.toLowerCase().trim();
                    const isActive = activeCondition === key;
                    return (
                      <button
                        key={key}
                        onClick={() => { setActiveCondition(isActive ? null : key); setCondYear(null); }}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          padding: "5px 11px", borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                          background: isActive ? "#0E1C2B" : "#F4F6F8",
                          color: isActive ? "#fff" : "#16222F",
                          border: "1.5px solid " + (isActive ? "#0E1C2B" : "#E1E6EB"),
                          transition: "background .12s, color .12s", cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.label}
                        {c.icd10cm && (
                          <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>{c.icd10cm}</span>
                        )}
                        <span style={{
                          fontSize: 10.5, fontWeight: 700,
                          background: isActive ? "rgba(255,255,255,.15)" : "#DDE2E7",
                          color: isActive ? "#fff" : "#5C6773",
                          padding: "1px 6px", borderRadius: 999,
                        }}>{c.count}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Timeline for selected condition — summary bar + year chips.
                    Encounters render compactly and only for the selected year,
                    keeping the page scannable instead of a wall of text. */}
                {activeCondition && (() => {
                  const cond = allConditions.find(c => c.label.toLowerCase().trim() === activeCondition);
                  if (!cond) return null;
                  const timeline = [...cond.entries].sort((a, b) =>
                    (a.date || "9999").localeCompare(b.date || "9999")
                  );
                  const first = timeline[0];
                  const last = timeline[timeline.length - 1];
                  const yearsSpanned = (first?.date && last?.date && first.date !== last.date)
                    ? Math.round((new Date(last.date) - new Date(first.date)) / (365.25 * 24 * 3600 * 1000))
                    : null;

                  // Group this condition's encounters by year
                  const condYearCounts = {};
                  timeline.forEach(e => {
                    const yr = e.date && /^\d{4}/.test(e.date) ? e.date.slice(0, 4) : "Undated";
                    condYearCounts[yr] = (condYearCounts[yr] || 0) + 1;
                  });
                  const condYears = Object.keys(condYearCounts).sort((a, b) => a.localeCompare(b)); // oldest first — forward story
                  const shownEncounters = condYear
                    ? timeline.filter(e => {
                        const yr = e.date && /^\d{4}/.test(e.date) ? e.date.slice(0, 4) : "Undated";
                        return yr === condYear;
                      })
                    : [];

                  return (
                    <div style={{ padding: "14px 16px" }}>
                      {/* Summary bar — the clinical headline for this condition */}
                      <div style={{
                        marginBottom: 12, padding: "10px 14px", background: "#F4F6F8",
                        borderRadius: 10, display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center",
                      }}>
                        <span className="disp" style={{ fontSize: 14.5, fontWeight: 700, color: "#16222F" }}>
                          {cond.label}
                        </span>
                        {cond.icd10cm && (
                          <span className="mono" style={{ fontSize: 11.5, color: "#0E7C86", fontWeight: 700 }}>
                            {cond.icd10cm}
                          </span>
                        )}
                        <span style={{ fontSize: 12, color: "#5C6773" }}>
                          {timeline.length} encounter{timeline.length === 1 ? "" : "s"}
                          {yearsSpanned !== null ? ` over ${yearsSpanned} year${yearsSpanned === 1 ? "" : "s"}` : ""}
                          {first?.date ? ` · first noted ${formatNarrativeDate(first.date)}` : ""}
                          {last?.date && last.date !== first?.date ? ` · most recent ${formatNarrativeDate(last.date)}` : ""}
                        </span>
                      </div>

                      {/* Year chips — brass, echoing the year timeline; oldest → newest */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: condYear ? 12 : 0 }}>
                        {condYears.map(yr => {
                          const isActive = condYear === yr;
                          return (
                            <button
                              key={yr}
                              onClick={() => setCondYear(isActive ? null : yr)}
                              className="disp"
                              style={{
                                display: "inline-flex", alignItems: "center", gap: 7,
                                padding: "5px 13px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                                background: isActive ? "#B5852A" : "#F7EFDC",
                                color: isActive ? "#fff" : "#B5852A",
                                border: "none", transition: "background .12s, color .12s", cursor: "pointer",
                              }}
                            >
                              {yr}
                              <span style={{
                                fontSize: 10.5, fontWeight: 700,
                                background: isActive ? "rgba(255,255,255,.2)" : "rgba(181,133,42,.15)",
                                padding: "1px 7px", borderRadius: 999,
                              }}>{condYearCounts[yr]}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Compact encounter rows for the selected year */}
                      {condYear && (
                        <div style={{ borderTop: "1px solid #EEF1F4" }}>
                          {shownEncounters.map((e, i) => {
                            const matchDx = (e.diagnoses || []).find(
                              dx => dx.description && dx.description.toLowerCase().trim() === activeCondition
                            );
                            const icd = matchDx?.icd10cm || cond.icd10cm;
                            const isFirstEver = e.id === first?.id;
                            const isLastEver = e.id === last?.id && timeline.length > 1;

                            return (
                              <div key={e.id} style={{
                                display: "flex", alignItems: "baseline", gap: 10, padding: "9px 4px",
                                borderBottom: i < shownEncounters.length - 1 ? "1px solid #F4F6F8" : "none",
                                flexWrap: "wrap",
                              }}>
                                <span className="mono" style={{ fontSize: 11.5, color: "#0E7C86", fontWeight: 700, flex: "none", width: 86 }}>
                                  {formatNarrativeDate(e.date)}
                                </span>
                                {isFirstEver && (
                                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".04em", color: "#B5852A", background: "#F7EFDC", padding: "2px 7px", borderRadius: 999 }}>
                                    FIRST NOTED
                                  </span>
                                )}
                                {isLastEver && (
                                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".04em", color: "#0E7C86", background: "#E9F4F4", padding: "2px 7px", borderRadius: 999 }}>
                                    MOST RECENT
                                  </span>
                                )}
                                {e.visit_setting && e.visit_setting !== "null" && (
                                  <span style={{ fontSize: 11.5, color: "#5C6773" }}>{e.visit_setting}</span>
                                )}
                                {icd && (
                                  <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: "#42505E", background: "#EEF1F4", padding: "1px 7px", borderRadius: 999 }}>
                                    {icd}
                                  </span>
                                )}
                                {(e.provider || e.facility_location) && (
                                  <span style={{ fontSize: 11.5, color: "#8A95A1", marginLeft: "auto" }}>
                                    {[e.provider ? `Dr. ${e.provider.replace(/^Dr\.?\s*/i, "")}` : null, e.facility_location].filter(Boolean).join(" · ")}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Search — two fields: condition/code and doctor name */}
            <div id="section-search" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }} className="no-print">
              <div style={{ position: "relative" }}>
                <Search size={16} style={{ position: "absolute", left: 14, top: 12, color: "#8A95A1" }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by condition or ICD-10-CM code"
                  style={{
                    width: "100%", fontSize: 13.5, padding: "11px 14px 11px 40px", borderRadius: 10,
                    border: "1px solid #DDE2E7", outline: "none", background: "#fff",
                  }}
                />
                {search && (
                  <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: 11, color: "#8A95A1" }}>
                    <X size={15} />
                  </button>
                )}
              </div>
              <div style={{ position: "relative" }}>
                <Stethoscope size={16} style={{ position: "absolute", left: 14, top: 12, color: "#8A95A1" }} />
                <input
                  value={doctorSearch}
                  onChange={e => setDoctorSearch(e.target.value)}
                  placeholder="Search by doctor or provider name"
                  style={{
                    width: "100%", fontSize: 13.5, padding: "11px 14px 11px 40px", borderRadius: 10,
                    border: "1px solid #DDE2E7", outline: "none", background: "#fff",
                  }}
                />
                {doctorSearch && (
                  <button onClick={() => setDoctorSearch("")} style={{ position: "absolute", right: 12, top: 11, color: "#8A95A1" }}>
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>

            {/* Tabs + actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }} className="no-print">
              <button className="tab-btn" data-on={view === "narrative"} onClick={() => setView("narrative")}>
                <ListOrdered size={14} /> Chronological summary
              </button>
              <button className="tab-btn" data-on={view === "raw"} onClick={() => setView("raw")}>
                <LayoutGrid size={14} /> Document details
              </button>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {(search || doctorSearch) && (
                  <span style={{ fontSize: 11.5, color: "#B5852A", fontWeight: 600 }}>
                    {filteredResults.length} result{filteredResults.length === 1 ? "" : "s"} — filters active
                  </span>
                )}
                <button onClick={() => setDownloadModal(true)} style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "#fff",
                  border: "none", borderRadius: 8, padding: "7px 14px", background: "#0E7C86",
                }}>
                  <Download size={13} /> Download Record
                </button>
                <button onClick={clearAll} style={{ fontSize: 12.5, color: "#B4302A", fontWeight: 600 }}>
                  Clear all
                </button>
              </span>
            </div>

            {filteredResults.length === 0 && (
              <div className="oath-card" style={{ padding: 24, textAlign: "center", color: "#8A95A1", fontSize: 13 }}>
                No records match "{search}". Try a broader term or a different ICD-10-CM code.
              </div>
            )}

            {/* Chronological narrative view — the "handoff form" */}
            {view === "narrative" && filteredResults.length > 0 && (
              <div id="section-summary" className="oath-card" style={{ padding: "24px 26px" }}>
                <div className="disp" style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
                  Chronological health summary{(displayName || identity.fullName) ? ` — ${displayName || identity.fullName}` : ""}
                </div>
                <div style={{ fontSize: 12, color: "#8A95A1", marginBottom: 18 }}>
                  {[identity.branch, identity.era].filter(Boolean).join(" · ")}
                  {(identity.branch || identity.era) && " · "}
                  Built from {stats.totalDocs} document{stats.totalDocs === 1 ? "" : "s"} · {stats.totalVisits} visit{stats.totalVisits === 1 ? "" : "s"} · newest first
                </div>
                <div style={{ position: "relative", paddingLeft: 4 }}>
                  <div style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 1.5, background: "#E1E6EB" }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    {(() => {
                      let lastYear = null;
                      return filteredResults.map(d => {
                        const yr = d.date ? d.date.slice(0, 4) : null;
                        const showHeader = yr && yr !== lastYear;
                        lastYear = yr;
                        return (
                          <React.Fragment key={d.id}>
                            {showHeader && (
                              <div style={{
                                marginLeft: -4, paddingLeft: 4, display: "flex", alignItems: "center", gap: 10,
                                marginTop: lastYear === yr ? 0 : 4,
                              }}>
                                <span className="disp" style={{
                                  fontSize: 13, fontWeight: 700, color: "#B5852A", background: "#F7EFDC",
                                  padding: "3px 12px", borderRadius: 999, letterSpacing: ".02em",
                                }}>
                                  {yr}
                                </span>
                                <span style={{ flex: 1, height: 1, background: "#EEF1F4" }} />
                              </div>
                            )}
                            <ChronoRow d={d} search={search} />
                          </React.Fragment>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* Raw document detail view — one card per uploaded document, not per event */}
            {view === "raw" && doneResults.length > 0 && (
              <div>
                {doneResults.map(item => (
                  <ResultCard key={item.id} item={item} onRemove={() => removeResult(item.id)} onRetry={() => retryFile(item)} />
                ))}
              </div>
            )}
          </>
        )}

        {results.length === 0 && queue.length === 0 && (
          <div className="no-print" style={{ textAlign: "center", padding: "30px 20px", color: "#8A95A1", fontSize: 13 }}>
            No documents yet. Drop one above to start building your record.
          </div>
        )}
      </div>
    </div>
  );
}
