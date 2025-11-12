export const renderFilterUiPage = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Filter Decks</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
      body { margin: 0; background: #0f172a; color: #e2e8f0; }
      header { padding: 1rem 2rem; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; }
      h1 { margin: 0; font-size: 1.25rem; }
      main { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; padding: 1rem 2rem 2rem; }
      section { background: #111827; border: 1px solid #1f2937; border-radius: 0.75rem; padding: 1rem; min-height: 80vh; display: flex; flex-direction: column; }
      section header { padding: 0 0 1rem; border: none; }
      section h2 { margin: 0; font-size: 1.1rem; }
      button, select, input, textarea { border-radius: 0.4rem; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; padding: 0.35rem 0.6rem; font-size: 0.95rem; }
      button.primary { background: #0ea5e9; border-color: #0ea5e9; color: #031525; font-weight: 600; }
      button.danger { background: #dc2626; border-color: #b91c1c; color: #fff; }
      button.secondary { background: #334155; border-color: #475569; }
      button + button { margin-left: 0.5rem; }
      textarea { width: 100%; min-height: 70px; resize: vertical; }
      .deck-cards { flex: 1; overflow-y: auto; padding-right: 0.25rem; }
      .card { border: 1px solid #243045; border-radius: 0.75rem; padding: 0.75rem; margin-bottom: 0.75rem; background: #0f172a; box-shadow: 0 4px 20px rgba(3, 6, 23, 0.6); }
      .card-title { width: 100%; border: none; background: transparent; color: #e2e8f0; font-size: 1.05rem; font-weight: 600; margin-bottom: 0.5rem; padding: 0.1rem 0; }
      .card-title:focus { outline: 2px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 0.35rem; padding: 0.25rem; }
      .field { margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.2rem; }
      label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: #94a3b8; }
      .card-controls { display: flex; justify-content: space-between; margin-top: 0.5rem; flex-wrap: wrap; gap: 0.5rem; }
      .pill { display: inline-flex; align-items: center; padding: 0.1rem 0.5rem; border-radius: 999px; background: #1e293b; font-size: 0.75rem; margin-right: 0.25rem; color: #cbd5f5; }
      .status-bar { font-size: 0.9rem; color: #94a3b8; }
      .toast { position: fixed; right: 1.5rem; bottom: 1.5rem; padding: 0.75rem 1rem; border-radius: 0.5rem; background: #10b981; color: #022c22; font-weight: 600; opacity: 0; transform: translateY(10px); transition: opacity 0.2s ease, transform 0.2s ease; }
      .toast.visible { opacity: 1; transform: translateY(0); }
      .tag-input { font-family: sfmono-regular, Consolas, monospace; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Filter Deck Studio</h1>
        <div class="status-bar" id="statusMsg">Loading decks…</div>
      </div>
      <div>
        <button id="addSuggest" class="secondary">Add Suggested Row</button>
        <button id="addFlag" class="secondary">Add Flag Row</button>
        <button id="saveBtn" class="primary">Save Decks</button>
      </div>
    </header>
    <main>
      <section data-deck="flag">
        <header><h2>Flag Deck</h2><div class="status-bar" id="flagCount"></div></header>
        <div class="deck-cards" id="flagCards"></div>
      </section>
      <section data-deck="suggest">
        <header><h2>Suggest Deck</h2><div class="status-bar" id="suggestCount"></div></header>
        <div class="deck-cards" id="suggestCards"></div>
      </section>
    </main>
    <div class="toast" id="toast"></div>
    <script>
      const state = {
        decks: { flag: { rows: [] }, suggest: { rows: [] } },
        dirty: false,
      };

      const htmlEscape = (value) =>
        String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      const toast = document.getElementById('toast');
      const statusMsg = document.getElementById('statusMsg');

      const showToast = (message, ok = true) => {
        toast.textContent = message;
        toast.style.background = ok ? '#10b981' : '#dc2626';
        toast.style.color = ok ? '#022c22' : '#fee2e2';
        toast.classList.add('visible');
        setTimeout(() => toast.classList.remove('visible'), 2800);
      };

      const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

      const deckContainers = {
        flag: document.getElementById('flagCards'),
        suggest: document.getElementById('suggestCards'),
      };

      document.getElementById('saveBtn').addEventListener('click', async () => {
        await saveDecks();
      });

      document.getElementById('addFlag').addEventListener('click', () => addRow('flag'));
      document.getElementById('addSuggest').addEventListener('click', () => addRow('suggest'));

      async function bootstrap() {
        statusMsg.textContent = 'Loading decks…';
        try {
          const response = await fetch('/api/decks');
          const payload = await response.json();
          state.decks.flag = payload.flag;
          state.decks.suggest = payload.suggest;
          state.dirty = false;
          statusMsg.textContent = 'Synced';
          renderAll();
        } catch (error) {
          statusMsg.textContent = 'Failed to load decks';
          showToast('Failed to load decks', false);
          console.error(error);
        }
      }

      function renderAll() {
        renderDeck('flag');
        renderDeck('suggest');
        document.getElementById('flagCount').textContent = state.decks.flag.rows.length + ' rows';
        document.getElementById('suggestCount').textContent = state.decks.suggest.rows.length + ' rows';
      }

      function renderDeck(kind) {
        const container = deckContainers[kind];
        container.innerHTML = '';
        state.decks[kind].rows.forEach((row) => {
          container.appendChild(renderCard(kind, row));
        });
      }

      function renderCard(kind, row) {
        const card = document.createElement('article');
        card.className = 'card';
        card.dataset.id = row.id;
        card.innerHTML = cardTemplate(kind, row);

        card.querySelectorAll('[data-field]').forEach((el) => {
          el.addEventListener('input', (event) => {
            const field = event.target.getAttribute('data-field');
            const value = event.target.value;
            updateField(kind, row.id, field, value);
          });
        });

        card.querySelectorAll('[data-action]').forEach((button) => {
          button.addEventListener('click', () => {
            const action = button.getAttribute('data-action');
            if (action === 'promote') {
              moveRow(row.id, kind, 'flag');
            } else if (action === 'demote') {
              moveRow(row.id, kind, 'suggest');
            } else if (action === 'delete') {
              deleteRow(kind, row.id);
            } else if (action === 'duplicate') {
              duplicateRow(kind, row);
            }
          });
        });

        return card;
      }

      function cardTemplate(kind, row) {
        return \`
          <input class="card-title" data-field="label" value="\${htmlEscape(row.label ?? 'Untitled filter')}" />
          <div class="field">
            <label>Intent question</label>
            <textarea data-field="intentQuestion">\${htmlEscape(row.intentQuestion ?? '')}</textarea>
          </div>
          <div class="field">
            <label>Scope</label>
            <textarea data-field="scope">\${htmlEscape(row.scope ?? '')}</textarea>
          </div>
          <div class="field">
            <label>Signals to pull</label>
            <textarea data-field="signalsToPull">\${htmlEscape(row.signalsToPull ?? '')}</textarea>
          </div>
          <div class="field">
            <label>Output lens</label>
            <textarea data-field="outputLens">\${htmlEscape(row.outputLens ?? '')}</textarea>
          </div>
          <div class="field">
            <label>Priority & Status</label>
            <div style="display:flex; gap:0.5rem;">
              <select data-field="priority">
                \${['high','medium','low'].map((opt) => \`<option value="\${opt}" \${row.priority === opt ? 'selected' : ''}>\${opt}</option>\`).join('')}
              </select>
              <select data-field="status">
                \${['active','suggested','draft','archived'].map((opt) => \`<option value="\${opt}" \${row.status === opt ? 'selected' : ''}>\${opt}</option>\`).join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Evidence floor</label>
            <input data-field="evidenceFloor" value="\${htmlEscape(row.evidenceFloor ?? '')}" />
          </div>
          <div class="field">
            <label>Perspective pairing</label>
            <input data-field="perspectivePairing" value="\${htmlEscape(row.perspectivePairing ?? '')}" />
          </div>
          <div class="field">
            <label>Tags (comma separated)</label>
            <input class="tag-input" data-field="tags" value="\${htmlEscape((row.tags || []).join(', '))}" />
          </div>
          <div class="field">
            <label>Insight quality (1-5)</label>
            <input type="number" min="1" max="5" step="1" data-field="insightQuality" value="\${htmlEscape(row.insightQuality ?? '')}" />
          </div>
          <div class="field">
            <label>Notes</label>
            <textarea data-field="notes">\${htmlEscape(row.notes ?? '')}</textarea>
          </div>
          <div class="card-controls">
            <div>
              <span class="pill">ID: \${htmlEscape((row.id || '').slice(0, 8))}</span>
              <span class="pill">Updated: \${htmlEscape((row.updatedAt || '').split('T')[0])}</span>
            </div>
            <div>
              \${kind === 'suggest' ? '<button data-action="promote">To Flag</button>' : '<button data-action="demote">To Suggest</button>'}
              <button data-action="duplicate" class="secondary">Duplicate</button>
              <button data-action="delete" class="danger">Delete</button>
            </div>
          </div>
        \`;
      }

      function updateField(deck, id, field, value) {
        const row = state.decks[deck].rows.find((entry) => entry.id === id);
        if (!row) return;
        if (field === 'tags') {
          row.tags = value.split(',').map((chunk) => chunk.trim()).filter(Boolean);
        } else if (field === 'insightQuality') {
          row.insightQuality = value ? Number(value) : undefined;
        } else if (field === 'priority' || field === 'status') {
          row[field] = value;
        } else {
          row[field] = value;
        }
        row.updatedAt = new Date().toISOString();
        state.dirty = true;
        statusMsg.textContent = 'Unsaved changes';
      }

      function moveRow(id, fromDeck, toDeck) {
        if (fromDeck === toDeck) return;
        const source = state.decks[fromDeck].rows;
        const target = state.decks[toDeck].rows;
        const index = source.findIndex((row) => row.id === id);
        if (index === -1) return;
        const [row] = source.splice(index, 1);
        row.deck = toDeck;
        target.unshift(row);
        state.dirty = true;
        renderAll();
      }

      function deleteRow(deck, id) {
        state.decks[deck].rows = state.decks[deck].rows.filter((row) => row.id !== id);
        state.dirty = true;
        renderAll();
      }

      function duplicateRow(deck, row) {
        const clone = JSON.parse(JSON.stringify(row));
        clone.id = uuid();
        clone.label = clone.label + ' (copy)';
        clone.createdAt = new Date().toISOString();
        clone.updatedAt = clone.createdAt;
        state.decks[deck].rows.unshift(clone);
        state.dirty = true;
        renderAll();
      }

      function addRow(deck) {
        const now = new Date().toISOString();
        const row = {
          id: uuid(),
          label: 'New filter row',
          intentQuestion: '',
          scope: '',
          signalsToPull: '',
          outputLens: '',
          priority: 'medium',
          status: deck === 'flag' ? 'active' : 'suggested',
          createdAt: now,
          updatedAt: now,
          deck,
        };
        state.decks[deck].rows.unshift(row);
        state.dirty = true;
        renderDeck(deck);
      }

      async function saveDecks() {
        statusMsg.textContent = 'Saving…';
        try {
          const payload = {
            flag: state.decks.flag.rows,
            suggest: state.decks.suggest.rows,
          };
          const response = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            throw new Error('Save failed');
          }
          const updated = await response.json();
          state.decks.flag = updated.flag;
          state.decks.suggest = updated.suggest;
          state.dirty = false;
          statusMsg.textContent = 'Saved';
          renderAll();
          showToast('Decks saved');
        } catch (error) {
          console.error(error);
          statusMsg.textContent = 'Save failed';
          showToast('Save failed', false);
        }
      }

      bootstrap();
    </script>
  </body>
</html>`;
