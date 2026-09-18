// Renders a single case's summary/detail row pair for the dashboard table.
import { formatStaleness } from './staleness.mjs';
import { escapeHtml } from './html_escape.mjs';
import { getStatusCategory } from './status_category.mjs';

/**
 * Renders the summary row and expandable detail row pair for a single case.
 * @param {object} c Case record
 * @returns {string}
 */
export function renderCaseRow(c) {
    const category = getStatusCategory(c.status, c.ballInCourt);
    const escapedCaseNum = escapeHtml(c.caseNumber);
    const escapedTitle = escapeHtml(c.title || 'Untitled Case');
    const escapedStatus = escapeHtml(c.status || 'Unknown');
    const escapedPriority = escapeHtml(c.priority || '');
    const escapedProduct = escapeHtml(c.product || '');
    const escapedSyncedAt = escapeHtml(c.syncedAt || '');
    const escapedRaisedBy = escapeHtml(c.raisedBy || '');
    const escapedOpenedAt = escapeHtml(c.openedAt || '');
    const commentCount = c.commentCount || 0;

    // Searchable text index for client-side filtering
    const searchTokens = [
      c.caseNumber,
      c.title,
      c.product,
      c.customerProject,
      c.raisedBy,
      c.contactName,
      c.status,
      c.priority,
      c.openedAt,
      ...(c.latestComments || []).map((cm) => `${cm.author} ${cm.snippet}`),
    ]
      .filter(Boolean)
      .join(' ');
    const escapedSearchIndex = escapeHtml(searchTokens);

    const escapedCustomerProject = escapeHtml(c.customerProject || '');
    const projectBadge = escapedCustomerProject
      ? ` <span class="badge badge-project">${escapedCustomerProject}</span>`
      : '';

    let commentsSection = '';
    if (c.latestComments && c.latestComments.length > 0) {
      const itemsHtml = c.latestComments
        .map((cm) => {
          return `
          <div class="comment-item">
            <div class="comment-header">
              <span class="comment-author">${escapeHtml(cm.author || 'Author')}</span>
              <span>${escapeHtml(cm.timestamp || '')}</span>
            </div>
            <div class="comment-body">${escapeHtml(cm.snippet)}</div>
          </div>`;
        })
        .join('');

      commentsSection = `
        <div class="comments-collapse-wrap">
          <button class="comments-toggle-btn" type="button">
            <span class="chevron">▸</span>
            <span>Recent Updates (${c.latestComments.length})</span>
          </button>
          <div class="comments-list comments-drawer">
            ${itemsHtml}
          </div>
        </div>`;
    }

    const metaLine = [
      escapedRaisedBy ? `Raised by: ${escapedRaisedBy}` : '',
      escapedCustomerProject ? `Project: ${escapedCustomerProject}` : '',
      escapedOpenedAt ? `Opened: ${escapedOpenedAt}` : '',
      escapedSyncedAt ? `Synced: ${escapedSyncedAt.slice(0, 10)}` : '',
      c.lastCommentAuthor ? `Latest by: ${escapeHtml(c.lastCommentAuthor)}` : '',
    ]
      .filter(Boolean)
      .map((part) => `<span>${part}</span>`)
      .join('');

    const caseNumElement = `<a href="qc://case/${escapedCaseNum}" class="case-number" title="Open in Qualcomm Profile (qc://)">#${escapedCaseNum}</a>`;

    const titleElement = `<a href="qc://case/${escapedCaseNum}" title="Open in Qualcomm Profile (qc://)">${escapedTitle}</a>`;

    let priorityClass = 'pri-normal';
    if (c.priority) {
      const p = String(c.priority).toLowerCase();
      if (p.includes('1') || p.includes('critical')) priorityClass = 'pri-critical';
      else if (p.includes('2') || p.includes('high')) priorityClass = 'pri-high';
    }

    const projectDisplay = escapedCustomerProject || escapedProduct;
    const openedDisplay = escapedOpenedAt || '-';
    const syncedDisplay = escapedSyncedAt ? escapedSyncedAt.slice(0, 10) : '-';
    const lastAuthorDisplay = c.lastCommentAuthor ? escapeHtml(c.lastCommentAuthor) : '-';
    const stalenessLabel = formatStaleness(c.lastCommentAt);
    const stalenessDisplay = stalenessLabel
      ? `<span class="activity-staleness" title="${escapeHtml(c.lastCommentAt)}">🕒 ${escapeHtml(stalenessLabel)}</span>`
      : '';

    return `
      <tr class="case-row" data-case-id="${escapedCaseNum}" data-status-category="${category}" data-search="${escapedSearchIndex}">
        <td class="caret-cell"><span class="caret">▸</span></td>
        <td>
          <div class="case-col">
            <div class="case-top">
              <span class="cell-case">${caseNumElement}</span>
              <span class="cell-title">${titleElement}</span>
            </div>
            <div class="case-meta-subline">
              <span>Project: <strong>${projectDisplay}</strong></span>${projectBadge}
              <span class="meta-dot">&bull;</span>
              <span>Raised by: <strong>${escapedRaisedBy || '-'}</strong></span>
            </div>
          </div>
        </td>
        <td>
          <div class="time-col">
            <span>🕒 Opened: ${openedDisplay}</span>
            <span>🔄 Synced: ${syncedDisplay}</span>
          </div>
        </td>
        <td>
          <div class="status-col">
            <div><span class="status-tag status-tag-${category}" title="${escapedStatus}">${escapedStatus}</span></div>
            <div><span class="pri-badge ${priorityClass}">${escapedPriority}</span></div>
          </div>
        </td>
        <td>
          <div class="activity-col">
            <span>Latest by: <strong>${lastAuthorDisplay}</strong></span>
            <span class="activity-comm-count">💬 ${commentCount} comments</span>
            ${stalenessDisplay}
          </div>
        </td>
        <td class="actions-cell">
          <button class="action-btn copy-btn" data-case-id="${escapedCaseNum}" title="Copy Case ID" type="button">📋</button>
          <button class="action-btn hide-btn" data-case-id="${escapedCaseNum}" title="Hide Case from active views" type="button">🚫</button>
          <button class="action-btn unhide-btn" data-case-id="${escapedCaseNum}" title="Unhide Case to active views" type="button">👁️</button>
          <button class="action-btn delete-btn" data-case-id="${escapedCaseNum}" title="🗑️ Delete: Copy chat instruction" type="button">🗑️</button>
        </td>
      </tr>
      <tr class="detail-row" data-case-detail="${escapedCaseNum}">
        <td colspan="6">
          <div class="meta-row">${metaLine}</div>
          ${commentsSection}
        </td>
      </tr>`;
}
