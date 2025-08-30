import React, { useState, useEffect, useMemo, useRef } from 'react';

function App() {
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('oz');
  const [notes, setNotes] = useState('');
  const [sessions, setSessions] = useState([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [theme, setTheme] = useState(() => (localStorage.getItem('theme') || 'light'));
  const touchStartX = useRef({});
  const touchTranslateX = useRef({});
  // For on-screen keypad we keep amount as a string and build it with button presses
  // (amount state is already a string). These helpers restrict to numbers + single decimal.

  const appendDigit = (digit) => {
    setAmount((prev) => {
      let next = prev || '';
      if (digit === '.') {
        if (next.includes('.')) return next; // only one decimal
        if (next === '') return '0.'; // leading decimal becomes 0.
        return next + '.';
      }
      // limit to 6 total chars before decimal to keep label readable
      const [intPart, decPart] = next.split('.');
      if (!decPart && intPart && intPart.length >= 6) return next;
      // limit to 2 decimal places after '.'
      if (decPart && decPart.length >= 2) return next;
      // avoid leading zeros like 00 -> treat as just digit
      if (next === '0') return digit;
      return next + digit;
    });
  };

  const backspace = () => setAmount((prev) => (prev ? prev.slice(0, -1) : ''));
  const clearAll = () => setAmount('');

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const response = await fetch('/api/sessions');
        const data = await response.json();
        setSessions(data.sessions);
        setTotalAmount(data.total);
      } catch (error) {
        console.error('Error fetching sessions:', error);
      }
    };
    fetchSessions();
  }, []);

  const handleUnitToggle = (newUnit) => {
    setUnit(newUnit);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      alert('Please enter a valid positive amount.');
      return;
    }

    setSubmitting(true);

    let amountInOz = parseFloat(amount);
    if (unit === 'ml') {
      amountInOz = amountInOz / 29.5735;
    }

    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: amountInOz, notes }),
      });

      if (response.ok) {
        const newSession = await response.json();
        setSessions([newSession, ...sessions]);
        setTotalAmount(totalAmount + newSession.amount_oz);
        // Server-side print (no dialog). Fallback to client print if it fails.
        try {
          const pr = await fetch('/api/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: newSession.id })
          });
          if (!pr.ok) throw new Error('print endpoint failed');
        } catch (e) {
          try { printLabel(newSession); } catch {}
        }
        setAmount('');
        setNotes('');
      } else {
        console.error('Failed to save session');
      }
    } catch (error) {
      console.error('Error saving session:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const ozToMl = (oz) => (oz * 29.5735).toFixed(1);
  const mlToOz = (ml) => (ml / 29.5735).toFixed(2);
  const applyTheme = (t) => {
    const root = document.documentElement;
    if (t === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  };

  const printLabel = (session) => {
    // Open a minimal print window with large, high-contrast label
    const w = window.open('', 'PRINT', 'height=400,width=600');
    if (!w) return;
    const dt = new Date(session.timestamp);
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Milk Label</title>
          <style>
            @page { size: 80mm auto; margin: 4mm; }
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
            .label { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; font-size: 14px; }
            .big { font-size: 24px; font-weight: 800; }
            .muted { color: #555; font-size: 12px; }
            .row { display: contents; }
            .right { text-align: right; }
            hr { border: 0; border-top: 1px dashed #999; margin: 8px 0; }
          </style>
        </head>
        <body>
          <div class="label">
            <div class="row"><div>Date</div><div class="right">${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}</div></div>
            <div class="row"><div>Amount</div><div class="right big">${session.amount_oz.toFixed(2)} oz (${ozToMl(session.amount_oz)} ml)</div></div>
            ${session.notes ? `<div class="row"><div>Notes</div><div class="right">${String(session.notes).slice(0, 60)}</div></div>` : ''}
            <hr />
            <div class="row"><div>Use by (fridge)</div><div class="right">${new Date(session.use_by_fridge).toLocaleDateString()}</div></div>
            <div class="row"><div>Use by (freeze)</div><div class="right">${new Date(session.use_by_frozen).toLocaleDateString()}</div></div>
          </div>
          <script>window.focus(); setTimeout(() => { try { window.print(); } catch(e){} window.close(); }, 100);</script>
        </body>
      </html>`;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (res.status === 204) {
        const session = sessions.find(s => s.id === id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (session) setTotalAmount((prev) => prev - session.amount_oz);
      }
    } catch (e) {
      console.error('Delete failed', e);
    }
  };

  const handleEdit = async (id) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const newAmount = prompt('New amount (oz):', s.amount_oz.toFixed(2));
    if (!newAmount) return;
    const amount_oz = parseFloat(newAmount);
    if (isNaN(amount_oz) || amount_oz <= 0) return alert('Invalid amount');
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_oz }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSessions((prev) => prev.map((x) => (x.id === id ? updated : x)));
        // recompute total
        setTotalAmount((prev) => prev - s.amount_oz + updated.amount_oz);
      }
    } catch (e) {
      console.error('Edit failed', e);
    }
  };

  const onTouchStart = (id) => (e) => {
    touchStartX.current[id] = e.touches[0].clientX;
    touchTranslateX.current[id] = 0;
  };
  const onTouchMove = (id) => (e) => {
    const dx = e.touches[0].clientX - (touchStartX.current[id] || 0);
    touchTranslateX.current[id] = Math.max(Math.min(dx, 96), -96); // clamp +/- 96px
    const row = document.getElementById(`row-${id}`);
    if (row) row.style.transform = `translateX(${touchTranslateX.current[id]}px)`;
  };
  const onTouchEnd = (id) => () => {
    const row = document.getElementById(`row-${id}`);
    const dx = touchTranslateX.current[id] || 0;
    // snap to actions if swiped > 48px
    const snap = dx > 48 ? 96 : dx < -48 ? -96 : 0;
    if (row) row.style.transform = `translateX(${snap}px)`;
    touchTranslateX.current[id] = snap;
  };

  const totalMl = useMemo(() => (totalAmount * 29.5735).toFixed(0), [totalAmount]);

  return (
    <div className="bg-gradient-to-b from-brand-50 to-white dark:from-gray-900 dark:to-gray-950 min-h-screen">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 dark:bg-gray-900/70 border-b border-brand-100 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-brand-700 dark:text-brand-300">Breast Milk Tracker</h1>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-gray-500 dark:text-gray-400">Total Stored</p>
            <p className="text-lg font-bold text-brand-600 dark:text-brand-400">{totalAmount.toFixed(2)} oz</p>
          </div>
          <button onClick={toggleTheme} className="ml-3 rounded-full border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm text-gray-700 dark:text-gray-200">
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 pb-28 pt-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="rounded-2xl bg-white dark:bg-gray-900 shadow-soft p-5">
            <div className="flex items-end justify-between gap-4">
              <div className="flex-1">
                <label htmlFor="amount" className="block text-sm font-medium text-gray-700">Amount</label>
                <div className="mt-2 flex items-stretch rounded-xl ring-1 ring-gray-300 focus-within:ring-2 focus-within:ring-brand-500 overflow-hidden">
                  <input
                    inputMode="decimal"
                    type="text"
                    id="amount"
                    value={amount}
                    readOnly
                    className="flex-1 px-4 py-4 text-2xl sm:text-3xl font-semibold placeholder-gray-300 focus:outline-none bg-transparent text-gray-900 dark:text-gray-100"
                    placeholder="0.0"
                  />
                  <div className="flex">
                    <button
                      type="button"
                      onClick={() => handleUnitToggle('oz')}
                      className={`px-4 sm:px-5 py-3 sm:py-4 text-lg font-semibold ${unit === 'oz' ? 'bg-brand-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'} active:scale-95 transition-transform`}
                      aria-pressed={unit === 'oz'}
                    >
                      oz
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUnitToggle('ml')}
                      className={`px-4 sm:px-5 py-3 sm:py-4 text-lg font-semibold ${unit === 'ml' ? 'bg-brand-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'} active:scale-95 transition-transform`}
                      aria-pressed={unit === 'ml'}
                    >
                      ml
                    </button>
                  </div>
                </div>
                {amount && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                    ≈ {unit === 'oz' ? ozToMl(parseFloat(amount)) : mlToOz(parseFloat(amount))} {unit === 'oz' ? 'ml' : 'oz'}
                  </p>
                )}
              </div>
              <div className="hidden sm:flex flex-col items-end min-w-[10rem]">
                <p className="text-sm text-gray-500">Total</p>
                <p className="text-3xl font-extrabold text-brand-600">{totalAmount.toFixed(2)} oz</p>
                <p className="text-xs text-gray-400">(~{totalMl} ml)</p>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Notes (optional)</label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows="3"
                className="mt-2 block w-full rounded-xl border-gray-300 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:ring-brand-500"
                placeholder="e.g., Left side, morning pump, baby just fed"
              />
            </div>

            {/* On-screen keypad */}
            <div className="mt-5 select-none">
              <div className="grid grid-cols-3 gap-3">
                {[1,2,3,4,5,6,7,8,9].map(n => (
                  <button key={n} onClick={() => appendDigit(String(n))} className="rounded-xl bg-gray-100 dark:bg-gray-800 py-4 text-2xl font-bold active:scale-95">{n}</button>
                ))}
                <button onClick={() => appendDigit('.')} className="rounded-xl bg-gray-100 dark:bg-gray-800 py-4 text-2xl font-bold active:scale-95">.</button>
                <button onClick={() => appendDigit('0')} className="rounded-xl bg-gray-100 dark:bg-gray-800 py-4 text-2xl font-bold active:scale-95">0</button>
                <button onClick={backspace} className="rounded-xl bg-amber-500 text-white py-4 text-xl font-semibold active:scale-95">⌫</button>
              </div>
              <div className="mt-3">
                <button onClick={clearAll} className="w-full rounded-xl bg-gray-200 dark:bg-gray-700 py-3 text-sm font-semibold active:scale-95">Clear</button>
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Pumping Sessions</h2>
            <div className="rounded-2xl bg-white dark:bg-gray-900 shadow-soft p-4 max-h-[calc(100vh-220px)] overflow-y-auto">
              <ul className="grid gap-3">
                {sessions.map((session) => (
                  <li key={session.id} className="relative overflow-hidden">
                    <div className="absolute inset-y-0 right-0 flex items-stretch gap-2 pr-2">
                      <button onClick={() => handleEdit(session.id)} className="my-2 rounded-lg bg-blue-600 text-white px-3 text-sm">Edit</button>
                      <button onClick={() => handleDelete(session.id)} className="my-2 rounded-lg bg-red-600 text-white px-3 text-sm">Delete</button>
                    </div>
                    <div
                      id={`row-${session.id}`}
                      onTouchStart={onTouchStart(session.id)}
                      onTouchMove={onTouchMove(session.id)}
                      onTouchEnd={onTouchEnd(session.id)}
                      className="rounded-2xl bg-white dark:bg-gray-900 p-4 shadow-soft active:scale-[0.99] transition-transform"
                    >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                          {session.amount_oz.toFixed(2)} oz
                          <span className="text-gray-400 dark:text-gray-500 font-medium"> • {ozToMl(session.amount_oz)} ml</span>
                        </p>
                        <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{new Date(session.timestamp).toLocaleString()}</p>
                        {session.notes && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{session.notes}</p>
                        )}
                      </div>
                      <div className="text-right text-xs text-gray-500 dark:text-gray-400 shrink-0">
                        <p className="font-medium">Refrigerate</p>
                        <p>{new Date(session.use_by_fridge).toLocaleDateString()}</p>
                        <p className="mt-1 font-medium">Freeze</p>
                        <p>{new Date(session.use_by_frozen).toLocaleDateString()}</p>
                      </div>
                    </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-20 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-t border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full rounded-xl bg-brand-600 text-white text-lg font-semibold py-4 shadow-soft active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save & Print Label'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
