import type { Kpis, Bottleneck, Variant, ExitMode, Readmissions, FilterParams } from "./api";

export type ReportData = {
  generatedAt: Date;
  period: { from: string; to: string };
  service: string;
  filters: FilterParams;
  kpis: Kpis;
  bottlenecks: Bottleneck[];
  variants: Variant[];
  exitModes: ExitMode[];
  readmissions: Readmissions | null;
  briefing: string | null;
};

const BRAND   = [6, 182, 212] as const;       // cyan-500
const BRAND_D = [14, 116, 144] as const;      // cyan-700
const SLATE_900 = [15, 23, 42] as const;
const SLATE_700 = [51, 65, 85] as const;
const SLATE_500 = [100, 116, 139] as const;
const SLATE_300 = [203, 213, 225] as const;
const ROSE  = [244, 63, 94] as const;
const AMBER = [245, 158, 11] as const;
const GREEN = [16, 185, 129] as const;

function fmtMin(m: number | null | undefined): string {
  if (m == null || isNaN(m)) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h} h ${r}` : `${h} h`;
}
function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("fr-FR");
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(digits)} %`;
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

export async function generateReport(data: ReportData): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();   // 210
  const H = pdf.internal.pageSize.getHeight();  // 297
  const M = 18;                                 // margin

  let y = 0;
  let pageNum = 0;

  // ── Page chrome ─────────────────────────────────────────────────────────
  function newPage(title?: string) {
    if (pageNum > 0) pdf.addPage();
    pageNum++;
    drawTopBar();
    drawFooter();
    y = M + 14;
    if (title) drawSectionTitle(title);
  }

  function drawTopBar() {
    // Brand color strip
    pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
    pdf.rect(0, 0, W, 4, "F");
    pdf.setFillColor(BRAND_D[0], BRAND_D[1], BRAND_D[2]);
    pdf.rect(0, 4, W, 0.6, "F");
    // Header text
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); pdf.setTextColor(SLATE_500[0], SLATE_500[1], SLATE_500[2]);
    pdf.text("ED FLOW INTELLIGENCE", M, 12);
    pdf.setFont("helvetica", "normal");
    pdf.text(data.service.toUpperCase(), W - M, 12, { align: "right" });
  }

  function drawFooter() {
    pdf.setDrawColor(230, 230, 230); pdf.setLineWidth(0.2);
    pdf.line(M, H - 14, W - M, H - 14);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(SLATE_500[0], SLATE_500[1], SLATE_500[2]);
    pdf.text(
      `Rapport généré le ${data.generatedAt.toLocaleString("fr-FR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      M, H - 9,
    );
    pdf.text(`p. ${pageNum}`, W - M, H - 9, { align: "right" });
  }

  function drawSectionTitle(label: string) {
    pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
    pdf.rect(M, y, 3, 6, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
    pdf.text(label, M + 6, y + 5);
    y += 10;
  }

  function ensure(h: number) {
    if (y + h > H - 18) newPage();
  }

  function drawKpiCard(x: number, w: number, label: string, value: string, hint?: string, color: readonly [number, number, number] = BRAND) {
    const h = 22;
    pdf.setFillColor(248, 250, 252);            // slate-50
    pdf.setDrawColor(226, 232, 240);            // slate-200
    pdf.roundedRect(x, y, w, h, 1.5, 1.5, "FD");
    // accent bar
    pdf.setFillColor(color[0], color[1], color[2]);
    pdf.roundedRect(x, y, 1.6, h, 0.5, 0.5, "F");
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(SLATE_500[0], SLATE_500[1], SLATE_500[2]);
    pdf.text(label.toUpperCase(), x + 4, y + 5);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(15); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
    pdf.text(value, x + 4, y + 13);
    if (hint) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(SLATE_500[0], SLATE_500[1], SLATE_500[2]);
      pdf.text(hint, x + 4, y + 18);
    }
  }

  function drawTable(
    cols: { label: string; w: number; align?: "left" | "right" }[],
    rows: (string | { value: string; bar?: number; color?: readonly [number, number, number] })[][],
  ) {
    const startX = M;
    const rowH = 7.5;
    const headerH = 6;

    // header
    pdf.setFillColor(241, 245, 249);            // slate-100
    pdf.rect(startX, y, W - 2 * M, headerH, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); pdf.setTextColor(SLATE_700[0], SLATE_700[1], SLATE_700[2]);
    let cx = startX + 2;
    cols.forEach((c) => {
      const tx = c.align === "right" ? cx + c.w - 2 : cx;
      pdf.text(c.label, tx, y + 4.2, { align: c.align ?? "left" });
      cx += c.w;
    });
    y += headerH;

    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
    rows.forEach((row, i) => {
      ensure(rowH + 4);
      if (i % 2 === 0) {
        pdf.setFillColor(252, 253, 254);
        pdf.rect(startX, y, W - 2 * M, rowH, "F");
      }
      cx = startX + 2;
      row.forEach((cell, j) => {
        const c = cols[j];
        const v = typeof cell === "string" ? cell : cell.value;
        const tx = c.align === "right" ? cx + c.w - 2 : cx;
        // optional inline bar (drawn behind text)
        if (typeof cell !== "string" && cell.bar != null) {
          const barW = Math.max(0, Math.min(1, cell.bar)) * (c.w - 4);
          const color = cell.color ?? BRAND;
          pdf.setFillColor(color[0], color[1], color[2]);
          pdf.rect(cx, y + rowH - 1.5, barW, 0.8, "F");
        }
        pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
        pdf.text(String(v), tx, y + 5, { align: c.align ?? "left" });
        cx += c.w;
      });
      y += rowH;
    });
    y += 4;
  }

  function paragraph(text: string, opts: { size?: number; color?: readonly [number, number, number]; bold?: boolean } = {}) {
    pdf.setFont("helvetica", opts.bold ? "bold" : "normal");
    pdf.setFontSize(opts.size ?? 9.5);
    const c = opts.color ?? SLATE_700;
    pdf.setTextColor(c[0], c[1], c[2]);
    const lines = pdf.splitTextToSize(text, W - 2 * M);
    ensure(lines.length * 5 + 2);
    pdf.text(lines, M, y + 4);
    y += lines.length * 5 + 4;
  }

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 1 — COVER
  // ───────────────────────────────────────────────────────────────────────
  pageNum++;
  drawTopBar();
  drawFooter();

  // Hero
  pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  pdf.rect(0, 30, W, 0.4, "F");

  pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(BRAND_D[0], BRAND_D[1], BRAND_D[2]);
  pdf.text("RAPPORT OPÉRATIONNEL", M, 50);

  pdf.setFont("helvetica", "bold"); pdf.setFontSize(28); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
  pdf.text("Service des urgences", M, 65);
  pdf.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
  pdf.text("pédiatriques", M, 78);

  pdf.setFont("helvetica", "normal"); pdf.setFontSize(11); pdf.setTextColor(SLATE_700[0], SLATE_700[1], SLATE_700[2]);
  pdf.text(`Période : ${fmtDate(data.period.from)} → ${fmtDate(data.period.to)}`, M, 92);
  pdf.setFontSize(9); pdf.setTextColor(SLATE_500[0], SLATE_500[1], SLATE_500[2]);
  pdf.text(`Document destiné au responsable de service · usage interne`, M, 99);

  // Hero KPIs
  y = 115;
  const cardW = (W - 2 * M - 8) / 3;
  const totalExits = data.exitModes.reduce((s, m) => s + m.count, 0);
  const hospExits = data.exitModes.filter(m => /hospit/i.test(m.mode)).reduce((s, m) => s + m.count, 0);
  drawKpiCard(M,                     cardW, "Dossiers traités",  fmtNum(data.kpis.total_dossiers), `${fmtNum(data.kpis.total_patients)} patients distincts`);
  drawKpiCard(M + cardW + 4,         cardW, "Durée de séjour médiane", fmtMin(data.kpis.los_median_min), `P90 : ${fmtMin(data.kpis.los_p90_min)}`);
  drawKpiCard(M + 2 * (cardW + 4),   cardW, "Taux d'hospitalisation",  fmtPct(data.kpis.hospit_pct), totalExits ? `${fmtNum(hospExits)} hospitalisés` : "");
  y += 26;

  drawKpiCard(M,                     cardW, "Évènements", fmtNum(data.kpis.total_events), "passages dans les locaux");
  drawKpiCard(M + cardW + 4,         cardW, "Goulot principal",
    data.bottlenecks[0]?.location ?? "—",
    data.bottlenecks[0] ? `moy. ${fmtMin(data.bottlenecks[0].mean_min)}` : "",
    data.bottlenecks[0] ? ROSE : SLATE_500);
  drawKpiCard(M + 2 * (cardW + 4),   cardW, "Réadmissions 30 j",
    data.readmissions ? fmtPct(data.readmissions.readmission_30d_rate) : "—",
    data.readmissions ? `7 j : ${fmtPct(data.readmissions.readmission_7d_rate)}` : "",
    AMBER);
  y += 26;

  // Mini briefing on cover if available
  if (data.briefing) {
    ensure(40);
    pdf.setFillColor(247, 250, 252);
    pdf.setDrawColor(226, 232, 240);
    pdf.roundedRect(M, y, W - 2 * M, 0, 2, 2, "FD"); // placeholder, replaced below

    const briefingY = y;
    const lines = pdf.splitTextToSize(data.briefing.replace(/\*\*/g, ""), W - 2 * M - 12);
    const blockH = 14 + lines.length * 4.6;
    pdf.setFillColor(247, 250, 252);
    pdf.setDrawColor(226, 232, 240);
    pdf.roundedRect(M, briefingY, W - 2 * M, blockH, 2, 2, "FD");
    pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
    pdf.roundedRect(M, briefingY, 1.6, blockH, 0.5, 0.5, "F");

    pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); pdf.setTextColor(BRAND_D[0], BRAND_D[1], BRAND_D[2]);
    pdf.text("SYNTHÈSE OPÉRATIONNELLE", M + 5, briefingY + 6);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
    pdf.text(lines, M + 5, briefingY + 12);
    y = briefingY + blockH + 6;
  }

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 2 — ACTIVITÉ
  // ───────────────────────────────────────────────────────────────────────
  newPage("1. Activité du service");
  paragraph(
    `Sur la période analysée, le service a pris en charge ${fmtNum(data.kpis.total_dossiers)} ` +
    `dossiers (${fmtNum(data.kpis.total_patients)} patients distincts), pour un total de ` +
    `${fmtNum(data.kpis.total_events)} évènements de localisation enregistrés. ` +
    `La durée de séjour médiane est de ${fmtMin(data.kpis.los_median_min)} ` +
    `(P90 = ${fmtMin(data.kpis.los_p90_min)}). Le taux d'hospitalisation atteint ` +
    `${fmtPct(data.kpis.hospit_pct)}.`,
  );

  y += 4;
  drawTable(
    [
      { label: "Indicateur",       w: (W - 2 * M) * 0.55 },
      { label: "Valeur",           w: (W - 2 * M) * 0.30, align: "right" },
      { label: "Note",             w: (W - 2 * M) * 0.15, align: "right" },
    ],
    [
      ["Dossiers traités",                fmtNum(data.kpis.total_dossiers),                 ""],
      ["Patients distincts",              fmtNum(data.kpis.total_patients),                 ""],
      ["Évènements de localisation",      fmtNum(data.kpis.total_events),                   ""],
      ["Durée de séjour — médiane (P50)", fmtMin(data.kpis.los_median_min),                 ""],
      ["Durée de séjour — P90",           fmtMin(data.kpis.los_p90_min),                    ""],
      ["Taux d'hospitalisation",          fmtPct(data.kpis.hospit_pct),                     ""],
    ],
  );

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 3 — GOULOTS
  // ───────────────────────────────────────────────────────────────────────
  newPage("2. Goulots d'étranglement");
  paragraph(
    "Localisations ordonnées par durée moyenne de passage. Les goulots critiques (rouge) " +
    "concentrent l'effort d'optimisation : ajout de capacité, redéploiement de ressources, " +
    "revue des protocoles d'engagement.",
  );

  const maxBottleneck = Math.max(...data.bottlenecks.map(b => b.mean_min ?? 0), 1);
  drawTable(
    [
      { label: "Localisation",     w: (W - 2 * M) * 0.30 },
      { label: "Passages",         w: (W - 2 * M) * 0.15, align: "right" },
      { label: "Moyenne",          w: (W - 2 * M) * 0.18, align: "right" },
      { label: "Médiane",          w: (W - 2 * M) * 0.18, align: "right" },
      { label: "P90",              w: (W - 2 * M) * 0.19, align: "right" },
    ],
    data.bottlenecks.slice(0, 10).map((b) => {
      const ratio = (b.mean_min ?? 0) / maxBottleneck;
      const color = ratio > 0.75 ? ROSE : ratio > 0.5 ? AMBER : GREEN;
      return [
        { value: b.location, bar: ratio, color },
        fmtNum(b.count),
        fmtMin(b.mean_min),
        fmtMin(b.median_min),
        fmtMin(b.p90_min),
      ];
    }),
  );

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 4 — VARIANTES DE PARCOURS
  // ───────────────────────────────────────────────────────────────────────
  newPage("3. Principales variantes de parcours");
  paragraph(
    "Les parcours patients les plus fréquents, par séquence de localisations. " +
    "Une concentration sur peu de variantes indique un service standardisé ; une dispersion forte " +
    "révèle une variabilité opérationnelle à investiguer.",
  );

  const maxVariant = Math.max(...data.variants.map(v => v.count), 1);
  drawTable(
    [
      { label: "#",                w: (W - 2 * M) * 0.06, align: "right" },
      { label: "Parcours (4 premières étapes)", w: (W - 2 * M) * 0.64 },
      { label: "Dossiers",         w: (W - 2 * M) * 0.15, align: "right" },
      { label: "Part",             w: (W - 2 * M) * 0.15, align: "right" },
    ],
    data.variants.slice(0, 10).map((v, i) => [
      String(i + 1),
      { value: v.sequence.slice(0, 4).join(" → ") + (v.sequence.length > 4 ? " → …" : ""), bar: v.count / maxVariant },
      fmtNum(v.count),
      `${(v.pct * 100).toFixed(1)} %`,
    ]),
  );

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 5 — DEVENIR DES PATIENTS
  // ───────────────────────────────────────────────────────────────────────
  newPage("4. Modes de sortie & qualité");
  paragraph(
    "Répartition des modes de sortie sur la période. Les ré-admissions à 7 et 30 jours " +
    "constituent un indicateur de qualité de prise en charge.",
  );

  const maxExit = Math.max(...data.exitModes.map(e => e.count), 1);
  drawTable(
    [
      { label: "Mode de sortie",   w: (W - 2 * M) * 0.50 },
      { label: "Dossiers",         w: (W - 2 * M) * 0.25, align: "right" },
      { label: "Part",             w: (W - 2 * M) * 0.25, align: "right" },
    ],
    data.exitModes.map((e) => [
      { value: e.mode, bar: e.count / maxExit },
      fmtNum(e.count),
      totalExits > 0 ? `${((e.count / totalExits) * 100).toFixed(1)} %` : "—",
    ]),
  );

  if (data.readmissions) {
    ensure(30);
    y += 2;
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(SLATE_900[0], SLATE_900[1], SLATE_900[2]);
    pdf.text("Réadmissions", M, y + 4);
    y += 8;
    const halfW = (W - 2 * M - 4) / 2;
    drawKpiCard(M,            halfW, "Réadmissions à 7 jours",  fmtPct(data.readmissions.readmission_7d_rate),  "indicateur de retours précoces", ROSE);
    drawKpiCard(M + halfW + 4, halfW, "Réadmissions à 30 jours", fmtPct(data.readmissions.readmission_30d_rate), "indicateur de qualité globale",  AMBER);
    y += 26;
  }

  // ───────────────────────────────────────────────────────────────────────
  // PAGE 6 — BRIEFING IA (si dispo)
  // ───────────────────────────────────────────────────────────────────────
  if (data.briefing) {
    newPage("5. Synthèse opérationnelle (IA locale)");
    paragraph(
      "Synthèse rédigée par l'assistant analytique local (modèle qwen2.5) à partir des chiffres ci-dessus. " +
      "Sert d'aide à la décision — à valider par le responsable de service.",
      { color: SLATE_500, size: 8.5 },
    );
    y += 2;
    paragraph(data.briefing.replace(/\*\*/g, ""), { size: 10, color: SLATE_900 });
  }

  // ── Save ────────────────────────────────────────────────────────────────
  const stamp = data.generatedAt.toISOString().slice(0, 10);
  pdf.save(`ED_Rapport_Service_${stamp}.pdf`);
}

void SLATE_300; // keep palette reference
