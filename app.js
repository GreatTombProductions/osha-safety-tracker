/**
 * OSHA Safety Tracker — Frontend Application
 *
 * Architecture:
 *   - stats.json loaded on page init (~7KB)
 *   - Search chunks loaded on demand by first letter (~1-3MB each)
 *   - Client-side fuzzy matching within loaded chunk
 *   - No backend, no API calls at runtime
 *
 * Search entry format (compact array):
 *   [0] display_name
 *   [1] states (comma-joined)
 *   [2] inspection_count
 *   [3] total_violations
 *   [4] willful
 *   [5] repeat
 *   [6] serious
 *   [7] other
 *   [8] total_penalties
 *   [9] fatality_inspections
 *   [10] earliest_year
 *   [11] latest_year
 */

(function () {
    'use strict';

    // -------------------------------------------------------
    // State
    // -------------------------------------------------------
    const searchCache = {};  // letter -> array of entries
    let currentResults = [];
    let stats = null;
    let allStates = new Set();
    let debounceTimer = null;

    // DOM refs
    const searchInput = document.getElementById('search-input');
    const searchStatus = document.getElementById('search-status');
    const filtersEl = document.getElementById('filters');
    const filterState = document.getElementById('filter-state');
    const filterSeverity = document.getElementById('filter-severity');
    const resultsEl = document.getElementById('results');
    const detailEl = document.getElementById('detail');
    const detailContent = document.getElementById('detail-content');
    const backBtn = document.getElementById('back-btn');
    const statsPanel = document.getElementById('stats-panel');

    // -------------------------------------------------------
    // Entry field accessors
    // -------------------------------------------------------
    const E = {
        name: e => e[0] || '',
        states: e => e[1] || '',
        stateList: e => (e[1] || '').split(',').filter(Boolean),
        inspections: e => e[2] || 0,
        violations: e => e[3] || 0,
        willful: e => e[4] || 0,
        repeat: e => e[5] || 0,
        serious: e => e[6] || 0,
        other: e => e[7] || 0,
        penalties: e => e[8] || 0,
        fatalities: e => e[9] || 0,
        earliestYear: e => e[10] || 0,
        latestYear: e => e[11] || 0,
    };

    // -------------------------------------------------------
    // Formatting helpers
    // -------------------------------------------------------
    function formatNumber(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
        return n.toLocaleString();
    }

    function formatDollars(n) {
        if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
        return '$' + n.toLocaleString();
    }

    // -------------------------------------------------------
    // Data loading
    // -------------------------------------------------------
    async function loadStats() {
        try {
            const resp = await fetch('data/stats.json');
            stats = await resp.json();
            renderStats();
        } catch (e) {
            console.error('Failed to load stats:', e);
        }
    }

    async function loadSearchChunk(letter) {
        const key = letter.toUpperCase();
        if (searchCache[key]) return searchCache[key];

        searchStatus.textContent = 'Loading...';
        try {
            const resp = await fetch(`data/search/${key}.json`);
            if (!resp.ok) return [];
            const data = await resp.json();
            searchCache[key] = data;

            // Collect all states for filter dropdown
            data.forEach(entry => {
                E.stateList(entry).forEach(st => allStates.add(st));
            });
            populateStateFilter();

            return data;
        } catch (e) {
            console.error(`Failed to load chunk ${key}:`, e);
            return [];
        }
    }

    // -------------------------------------------------------
    // Search
    // -------------------------------------------------------
    function normalizeQuery(q) {
        return q.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    }

    function searchEntries(entries, query) {
        const norm = normalizeQuery(query);
        if (!norm) return [];

        const words = norm.split(/\s+/);

        return entries
            .map(entry => {
                const name = (entry[0] || '').toUpperCase();
                let score = 0;

                // Exact prefix match on full name
                if (name.startsWith(norm)) score += 100;

                // All words present
                const allPresent = words.every(w => name.includes(w));
                if (allPresent) score += 50;
                else return null;

                // Boost by inspection count (log scale)
                score += Math.log10(Math.max(E.inspections(entry), 1)) * 5;

                // Boost for severity
                if (E.fatalities(entry) > 0) score += 20;
                if (E.willful(entry) > 0) score += 10;

                return { entry, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, 100)
            .map(r => r.entry);
    }

    async function doSearch() {
        const query = searchInput.value.trim();

        if (query.length < 2) {
            resultsEl.innerHTML = '';
            filtersEl.classList.add('hidden');
            statsPanel.classList.remove('hidden');
            searchStatus.textContent = '';
            currentResults = [];
            return;
        }

        statsPanel.classList.add('hidden');
        detailEl.classList.add('hidden');

        // Determine which chunk to load
        const firstChar = normalizeQuery(query)[0];
        if (!firstChar) return;

        let chunkKey;
        if (/[A-Z]/.test(firstChar)) chunkKey = firstChar;
        else if (/[0-9]/.test(firstChar)) chunkKey = '0';
        else chunkKey = '_';

        const entries = await loadSearchChunk(chunkKey);
        const results = searchEntries(entries, query);

        currentResults = results;
        applyFilters();
    }

    function applyFilters() {
        const stateFilter = filterState.value;
        const severityFilter = filterSeverity.value;

        let filtered = currentResults;

        if (stateFilter) {
            filtered = filtered.filter(e =>
                E.stateList(e).includes(stateFilter)
            );
        }

        if (severityFilter) {
            filtered = filtered.filter(e => {
                switch (severityFilter) {
                    case 'fatality': return E.fatalities(e) > 0;
                    case 'willful': return E.willful(e) > 0;
                    case 'repeat': return E.repeat(e) > 0;
                    case 'serious': return E.serious(e) > 0;
                    default: return true;
                }
            });
        }

        renderResults(filtered);
        filtersEl.classList.remove('hidden');
        searchStatus.textContent = `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;
    }

    // -------------------------------------------------------
    // Rendering: Results
    // -------------------------------------------------------
    function renderResults(results) {
        if (results.length === 0) {
            resultsEl.innerHTML = '<div class="search-status">No results found.</div>';
            return;
        }

        resultsEl.innerHTML = results.map((entry, idx) => {
            const name = E.name(entry);
            const states = E.states(entry);
            const inspections = E.inspections(entry);
            const violations = E.violations(entry);
            const penalties = E.penalties(entry);
            const fatalities = E.fatalities(entry);
            const willful = E.willful(entry);
            const repeat = E.repeat(entry);
            const serious = E.serious(entry);
            const earliest = E.earliestYear(entry);
            const latest = E.latestYear(entry);

            let dateRange = '';
            if (earliest && latest) {
                dateRange = earliest === latest ? `${earliest}` : `${earliest}–${latest}`;
            }

            // Badges
            let badges = '';
            if (fatalities > 0) {
                badges += `<span class="badge badge-fatality">${fatalities} fatality inv.</span>`;
            }
            if (willful > 0) {
                badges += `<span class="badge badge-willful">${willful} willful</span>`;
            }
            if (repeat > 0) {
                badges += `<span class="badge badge-repeat">${repeat} repeat</span>`;
            }
            if (serious > 0) {
                badges += `<span class="badge badge-serious">${serious} serious</span>`;
            }

            return `
                <div class="result-card" data-idx="${idx}">
                    <div class="result-name">
                        ${escapeHtml(name)}
                    </div>
                    <div class="result-meta">
                        <span>${states}</span>
                        <span>${inspections.toLocaleString()} inspection${inspections !== 1 ? 's' : ''}</span>
                        <span>${violations.toLocaleString()} violation${violations !== 1 ? 's' : ''}</span>
                        ${penalties > 0 ? `<span>${formatDollars(penalties)} penalties</span>` : ''}
                        ${dateRange ? `<span>${dateRange}</span>` : ''}
                    </div>
                    ${badges ? `<div class="result-badges">${badges}</div>` : ''}
                </div>
            `;
        }).join('');

        // Click handlers
        resultsEl.querySelectorAll('.result-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx);
                showDetail(results[idx]);
            });
        });
    }

    // -------------------------------------------------------
    // Rendering: Detail View
    // -------------------------------------------------------
    function showDetail(entry) {
        const name = E.name(entry);
        const states = E.states(entry);
        const inspections = E.inspections(entry);
        const violations = E.violations(entry);
        const willful = E.willful(entry);
        const repeat = E.repeat(entry);
        const serious = E.serious(entry);
        const other = E.other(entry);
        const penalties = E.penalties(entry);
        const fatalities = E.fatalities(entry);
        const earliest = E.earliestYear(entry);
        const latest = E.latestYear(entry);

        let dateRange = '';
        if (earliest && latest) {
            dateRange = earliest === latest ? `${earliest}` : `${earliest} – ${latest}`;
        }

        // Severity bar
        const total = willful + repeat + serious + other;
        let severityBar = '';
        let severityLegend = '';
        if (total > 0) {
            const pct = v => Math.max((v / total) * 100, v > 0 ? 2 : 0);
            severityBar = `
                <div class="severity-bar">
                    ${willful > 0 ? `<div class="severity-bar-willful" style="width:${pct(willful)}%"></div>` : ''}
                    ${repeat > 0 ? `<div class="severity-bar-repeat" style="width:${pct(repeat)}%"></div>` : ''}
                    ${serious > 0 ? `<div class="severity-bar-serious" style="width:${pct(serious)}%"></div>` : ''}
                    ${other > 0 ? `<div class="severity-bar-other" style="width:${pct(other)}%"></div>` : ''}
                </div>
            `;

            const items = [];
            if (willful > 0) items.push(`<span class="severity-legend-item"><span class="severity-dot" style="background:var(--willful)"></span> Willful: ${willful.toLocaleString()}</span>`);
            if (repeat > 0) items.push(`<span class="severity-legend-item"><span class="severity-dot" style="background:var(--repeat)"></span> Repeat: ${repeat.toLocaleString()}</span>`);
            if (serious > 0) items.push(`<span class="severity-legend-item"><span class="severity-dot" style="background:var(--serious)"></span> Serious: ${serious.toLocaleString()}</span>`);
            if (other > 0) items.push(`<span class="severity-legend-item"><span class="severity-dot" style="background:var(--other)"></span> Other: ${other.toLocaleString()}</span>`);
            severityLegend = `<div class="severity-legend">${items.join('')}</div>`;
        }

        // Fatality badge
        const fatalBadge = fatalities > 0
            ? `<span class="badge badge-fatality">${fatalities} fatality investigation${fatalities !== 1 ? 's' : ''}</span>`
            : '';

        detailContent.innerHTML = `
            <div class="detail-header">
                <div class="detail-name">
                    ${escapeHtml(name)}
                    ${fatalBadge}
                </div>
                <div class="detail-subtitle">
                    ${states ? `States: ${states}` : ''}
                    ${dateRange ? ` · ${dateRange}` : ''}
                </div>
            </div>

            <div class="detail-stats">
                <div class="detail-stat">
                    <div class="detail-stat-value">${inspections.toLocaleString()}</div>
                    <div class="detail-stat-label">Inspections</div>
                </div>
                <div class="detail-stat">
                    <div class="detail-stat-value">${violations.toLocaleString()}</div>
                    <div class="detail-stat-label">Violations</div>
                </div>
                <div class="detail-stat">
                    <div class="detail-stat-value">${formatDollars(penalties)}</div>
                    <div class="detail-stat-label">Penalties</div>
                </div>
                ${fatalities > 0 ? `
                <div class="detail-stat" style="background:var(--fatality-bg)">
                    <div class="detail-stat-value" style="color:var(--fatality)">${fatalities}</div>
                    <div class="detail-stat-label">Fatality Inv.</div>
                </div>
                ` : ''}
            </div>

            ${total > 0 ? `
                <h3 style="font-size:0.9rem;margin-bottom:0.5rem;color:var(--text-secondary)">Violation Severity</h3>
                ${severityBar}
                ${severityLegend}
            ` : ''}

            <div class="detail-disclaimer">
                <strong>About this data:</strong> OSHA inspection and violation records from the
                U.S. Department of Labor. Violation types have legal meaning:
                <strong>Willful</strong> means the employer intentionally violated or showed plain
                indifference to the law. <strong>Repeat</strong> means a substantially similar
                violation was previously cited. <strong>Serious</strong> means substantial probability
                of death or serious physical harm. Penalty amounts shown are the most recent
                (current) penalty and may have been reduced through settlement.
                This tool presents federal data and is not legal advice.
            </div>
        `;

        resultsEl.classList.add('hidden');
        filtersEl.classList.add('hidden');
        detailEl.classList.remove('hidden');
    }

    function hideDetail() {
        detailEl.classList.add('hidden');
        resultsEl.classList.remove('hidden');
        filtersEl.classList.remove('hidden');
    }

    // -------------------------------------------------------
    // Rendering: Stats
    // -------------------------------------------------------
    function renderStats() {
        if (!stats) return;

        const grid = document.getElementById('stats-grid');
        grid.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${formatNumber(stats.total_inspections)}</div>
                <div class="stat-label">Inspections</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatNumber(stats.total_violations)}</div>
                <div class="stat-label">Violations</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatDollars(stats.total_penalties)}</div>
                <div class="stat-label">Penalties</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatNumber(stats.fatality_inspections)}</div>
                <div class="stat-label">Fatality Investigations</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatNumber(stats.unique_employers)}</div>
                <div class="stat-label">Employers</div>
            </div>
        `;

        // Top industries
        const indEl = document.getElementById('top-industries');
        if (stats.top_industries && stats.top_industries.length > 0) {
            indEl.innerHTML = `
                <h3>Inspections by Industry</h3>
                <div class="industry-list">
                    ${stats.top_industries.map(ind => `
                        <div class="industry-row">
                            <span class="industry-name">${escapeHtml(ind.n)}</span>
                            <span class="industry-count">${formatNumber(ind.i)} inspections · ${formatDollars(ind.p)}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Violation type breakdown
        const violEl = document.getElementById('violation-breakdown');
        if (stats.by_viol_type) {
            const types = Object.entries(stats.by_viol_type);
            if (types.length > 0) {
                const colorMap = {
                    'Willful': 'var(--willful)',
                    'Repeat': 'var(--repeat)',
                    'Serious': 'var(--serious)',
                    'Other': 'var(--other)',
                    'Unclassified': '#999',
                };
                violEl.innerHTML = `
                    <h3>Violations by Severity</h3>
                    <div class="viol-type-list">
                        ${types.map(([name, data]) => `
                            <div class="viol-type-row" style="background:${colorMap[name] || 'var(--bg)'}11">
                                <span class="viol-type-name" style="color:${colorMap[name] || 'var(--text)'}">${name}</span>
                                <span class="viol-type-count">${formatNumber(data.count)} · ${formatDollars(data.penalties)}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            }
        }
    }

    // -------------------------------------------------------
    // Filter dropdown population
    // -------------------------------------------------------
    function populateStateFilter() {
        const sorted = Array.from(allStates).sort();
        const existing = new Set(Array.from(filterState.options).map(o => o.value));

        sorted.forEach(st => {
            if (!existing.has(st)) {
                const opt = document.createElement('option');
                opt.value = st;
                opt.textContent = st;
                filterState.appendChild(opt);
            }
        });
    }

    // -------------------------------------------------------
    // Utility
    // -------------------------------------------------------
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // -------------------------------------------------------
    // Event listeners
    // -------------------------------------------------------
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, 150);
    });

    filterState.addEventListener('change', applyFilters);
    filterSeverity.addEventListener('change', applyFilters);
    backBtn.addEventListener('click', hideDetail);

    // Keyboard: Escape goes back
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !detailEl.classList.contains('hidden')) {
            hideDetail();
        }
    });

    // -------------------------------------------------------
    // Init
    // -------------------------------------------------------
    loadStats();

})();
