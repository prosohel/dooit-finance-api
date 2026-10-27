/**
 * The printable Case Summary: one A4 document carrying what a reviewer needs
 * to pick the case up — identity, risk, the people on it, the alerts and
 * transactions it covers — rendered server-side so every officer gets the
 * same bytes (same reasoning as the SMR/ECDD/GFS exports).
 *
 * Built from the SAME lean populated case the detail endpoint serves, so the
 * document can never say more than the requesting role can see: encrypted POI
 * fields arrive masked ("***") for viewers without the decrypt grant and are
 * printed as such.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtAUD = (n) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);

const fmtMoney = (amount, currency) => {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency || 'AUD' }).format(
      amount || 0
    );
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
};

const humanize = (v) =>
  v == null || v === ''
    ? '—'
    : String(v).replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

const partyLine = (party) => {
  if (!party) return '—';
  return esc(party.name || party.account || party.institution || '—');
};

// Customer display name without decrypting anything: the linked user record's
// name, else the customer reference.
const customerName = (c) => c?.user?.name || c?.uid || '—';

const field = (label, value) =>
  `<div class="field"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;

function buildCaseSummaryHtml(caseDoc, { netActivity = 0, generatedBy = '' } = {}) {
  const customers = caseDoc.linkedCustomers || [];
  const externalPois = caseDoc.externalPois || [];
  const alerts = caseDoc.linkedAlerts || [];
  const txns = caseDoc.linkedTransactions || [];
  const primaryId = String(caseDoc.customer?._id || caseDoc.customer || '');

  const overdue = caseDoc.slaDeadline && new Date(caseDoc.slaDeadline).getTime() < Date.now();

  const customerRows = customers
    .map((c) => {
      const isPrimary = String(c._id) === primaryId;
      return `<tr>
        <td>${esc(customerName(c))}${isPrimary ? ' <span class="tag">Primary subject</span>' : ''}</td>
        <td class="mono">${esc(c.uid || '—')}</td>
        <td>${esc(humanize(c.kycStatus))}</td>
        <td>${c.isPep ? 'PEP' : 'Not a PEP'}</td>
        <td>${c.sanction ? '<strong>Match</strong>' : 'No match'}</td>
      </tr>`;
    })
    .join('');

  const externalRows = externalPois
    .map(
      (p) => `<tr>
        <td>${esc(p.name || '—')}</td>
        <td>${p.kind === 'entity' ? 'Entity' : 'Individual'}</td>
        <td>${esc(humanize(p.role))}</td>
        <td>${
          p.source === 'alert'
            ? `Alert ${esc(p.sourceAlertUid || '')} · ${esc(humanize(p.sourcePartySlot))}`
            : 'Manual entry'
        }</td>
      </tr>`
    )
    .join('');

  const alertRows = alerts
    .map(
      (a) => `<tr>
        <td class="mono">${esc(a.uid || '—')}</td>
        <td>${esc([a.ruleId, a.ruleName].filter(Boolean).join(': ') || a.explanation || '—')}</td>
        <td>${a.riskScore ?? '—'}${a.riskLabel ? ` · ${esc(a.riskLabel)}` : ''}</td>
        <td>${esc(humanize(a.status))}</td>
        <td>${fmtDate(a.createdAt)}</td>
      </tr>`
    )
    .join('');

  const txnRows = txns
    .map((t) => {
      const flags = (t.riskFlags || []).join(', ');
      const aud = t.convertedAmountAUD ?? t.amount ?? 0;
      return `<tr>
        <td>${fmtDate(t.timestamp)}<div class="mono dim">${esc(t.uid || '')}</div></td>
        <td>${esc(humanize(t.channel || t.type))}</td>
        <td class="num">${fmtMoney(t.amount, t.currency)}${
          t.currency && t.currency !== 'AUD' ? `<div class="dim">≈ ${fmtAUD(aud)}</div>` : ''
        }</td>
        <td>${partyLine(t.sender)} → ${partyLine(t.receiver)}</td>
        <td>${flags ? esc(flags) : '—'}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 13mm 18mm; }
  :root { color-scheme: only light; }
  * { box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9px;
         color: #20232a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .masthead { border-bottom: 2px solid #005964; padding-bottom: 9px; margin-bottom: 13px; }
  .masthead .doc-type { font-size: 15px; font-weight: 700; color: #005964; }
  .masthead .case-title { font-size: 11px; font-weight: 700; margin-top: 3px; }
  .masthead .meta { font-size: 8px; color: #6a6f78; margin-top: 3px; }

  h2 { font-size: 10px; color: #005964; border-bottom: 1px solid #d8dde2; padding-bottom: 3px;
       margin: 14px 0 7px; page-break-after: avoid; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px 14px; }
  .field .label { font-size: 7px; text-transform: uppercase; letter-spacing: 0.4px; color: #8a8f98; }
  .field .value { font-size: 9px; font-weight: 600; margin-top: 1px; }

  table { width: 100%; border-collapse: collapse; font-size: 8.5px; }
  th { text-align: left; font-size: 7px; text-transform: uppercase; letter-spacing: 0.4px;
       color: #8a8f98; border-bottom: 1px solid #d8dde2; padding: 3px 6px 3px 0; }
  td { border-bottom: 1px solid #eef0f3; padding: 4px 6px 4px 0; vertical-align: top; }
  tr { page-break-inside: avoid; }
  td.num { white-space: nowrap; font-weight: 600; }
  .totals td { border-bottom: none; border-top: 1.5px solid #d8dde2; font-weight: 700; }

  .mono { font-family: Consolas, "Courier New", monospace; font-size: 8px; }
  .dim { color: #8a8f98; font-weight: 400; }
  .tag { font-size: 7px; font-weight: 700; color: #005964; background: #e6f0f1;
         border-radius: 6px; padding: 1px 5px; }
  .danger { color: #ca2f7f; font-weight: 700; }
  .none { color: #8a8f98; font-style: italic; }
  .desc { white-space: pre-wrap; }

  .confidential { margin-top: 16px; border-top: 1px solid #d8dde2; padding-top: 7px;
                  font-size: 7.5px; color: #6a6f78; }
</style></head><body>

  <div class="masthead">
    <div class="doc-type">Case Summary</div>
    <div class="case-title">${esc(caseDoc.title || '')}</div>
    <div class="meta">${esc(caseDoc.uid || caseDoc._id)} &middot; Generated ${fmtDate(new Date())}${
      generatedBy ? ` by ${esc(generatedBy)}` : ''
    }</div>
  </div>

  <h2>Overview</h2>
  <div class="grid">
    ${field('Status', esc(humanize(caseDoc.status)))}
    ${field('Priority', esc(humanize(caseDoc.priority)))}
    ${field('Type', esc(caseDoc.caseType || humanize(caseDoc.type)))}
    ${field(
      'Risk score',
      `${caseDoc.riskScore ?? '—'}${caseDoc.riskLabel ? ` · ${esc(caseDoc.riskLabel)}` : ''}`
    )}
    ${field('Created', fmtDate(caseDoc.createdAt))}
    ${field('Last updated', fmtDate(caseDoc.updatedAt))}
    ${field(
      'SLA deadline',
      caseDoc.slaDeadline
        ? `${fmtDate(caseDoc.slaDeadline)}${overdue ? ' <span class="danger">Overdue</span>' : ''}`
        : '—'
    )}
    ${field('Investigator', esc(caseDoc.assignedTo?.name || 'Unassigned'))}
    ${field('Created by', esc(caseDoc.createdBy?.name || '—'))}
    ${field('Decision', esc(humanize(caseDoc.decision)))}
    ${field('Net activity (AUD)', fmtAUD(netActivity))}
    ${field('Linked alerts', String(alerts.length))}
  </div>

  ${
    caseDoc.description
      ? `<h2>Description</h2><p class="desc">${esc(caseDoc.description)}</p>`
      : ''
  }

  <h2>Persons of interest — customers (${customers.length})</h2>
  ${
    customerRows
      ? `<table><thead><tr><th>Name</th><th>Reference</th><th>KYC</th><th>PEP</th><th>Sanctions</th></tr></thead>
         <tbody>${customerRows}</tbody></table>`
      : '<p class="none">No customers are linked to this case.</p>'
  }

  ${
    externalRows
      ? `<h2>Persons of interest — not customers (${externalPois.length})</h2>
         <table><thead><tr><th>Name</th><th>Kind</th><th>Role</th><th>Source</th></tr></thead>
         <tbody>${externalRows}</tbody></table>`
      : ''
  }

  <h2>Linked alerts (${alerts.length})</h2>
  ${
    alertRows
      ? `<table><thead><tr><th>Reference</th><th>Detection rule</th><th>Risk</th><th>Status</th><th>Raised</th></tr></thead>
         <tbody>${alertRows}</tbody></table>`
      : '<p class="none">No alerts are linked to this case.</p>'
  }

  <h2>Linked transactions (${txns.length})</h2>
  ${
    txnRows
      ? `<table><thead><tr><th>Date / reference</th><th>Channel</th><th>Amount</th><th>Sender → Receiver</th><th>Risk flags</th></tr></thead>
         <tbody>${txnRows}
         <tr class="totals"><td colspan="2">Total (AUD)</td><td class="num">${fmtAUD(
           netActivity
         )}</td><td colspan="2"></td></tr></tbody></table>`
      : '<p class="none">No transactions are linked to this case.</p>'
  }

  <div class="confidential">
    Internal working document of an AML/CTF investigation. It may concern a suspicious matter:
    disclosing its existence or contents to the person it concerns, or to any person other than
    as permitted by the AML/CTF Act 2006, may constitute an offence of tipping off under s123.
    Handle and retain in accordance with the reporting entity's record-keeping obligations.
  </div>

</body></html>`;
}

module.exports = { buildCaseSummaryHtml };
