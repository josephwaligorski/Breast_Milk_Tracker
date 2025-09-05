import React, { useState, useEffect, useMemo, useRef } from 'react';

function App() {
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('oz');
  const [notes, setNotes] = useState('');
  const [sessions, setSessions] = useState([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [theme, setTheme] = useState(() => (localStorage.getItem('theme') || 'light'));
  const [printMode, setPrintMode] = useState(() => localStorage.getItem('printMode') || 'agent');
  const [printerId, setPrinterId] = useState(() => localStorage.getItem('printerId') || '');
  const [netHost, setNetHost] = useState(() => localStorage.getItem('netHost') || '');
  const [netPort, setNetPort] = useState(() => {
    const v = localStorage.getItem('netPort');
    return v ? Number(v) : 9100;
  });
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

  useEffect(() => { localStorage.setItem('printMode', printMode); }, [printMode]);
  useEffect(() => { localStorage.setItem('printerId', printerId || ''); }, [printerId]);
  useEffect(() => { localStorage.setItem('netHost', netHost || ''); }, [netHost]);
  useEffect(() => { localStorage.setItem('netPort', String(netPort || '')); }, [netPort]);

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
        // Choose print strategy based on selection
        try {
          if (printMode === 'device') {
            window.open(`/labels/${newSession.id}`, '_blank', 'noopener,noreferrer');
          } else if (printMode === 'network') {
            if (!netHost) throw new Error('Network printer host required');
            const pr = await fetch('/api/print', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: newSession.id, directTcpPrinter: { host: netHost, port: Number(netPort || 9100) } })
            });
            if (!pr.ok) {
              // Fallback to local print dialog
              window.open(`/labels/${newSession.id}`, '_blank', 'noopener,noreferrer');
            }
          } else {
            // Agent/queue mode (optionally targeted)
            await fetch('/api/print', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: newSession.id, printerId: printerId || undefined })
            });
          }
        } catch (e) {
          try { window.open(`/labels/${newSession.id}`, '_blank', 'noopener,noreferrer'); } catch {}
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

  // (deprecated) printLabel helper replaced by /labels/:id route

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

  const handleLocalPrint = (id) => {
    const url = `/labels/${id}`;
    window.open(url, '_blank', 'noopener,noreferrer');
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
    <div className="bg-gradient-to-b from-brand-50 to-white dark:from-gray-900 dark:to-gray-950 h-screen overflow-hidden">
      <header className="backdrop-blur bg-white/70 dark:bg-gray-900/70 border-b border-brand-100 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-2 py-1 flex items-center justify-between gap-2">
          <h1 className="text-sm font-bold tracking-tight text-brand-700 dark:text-brand-300">Breast Milk Tracker</h1>
          <div className="text-right">
            <p className="text-xs text-gray-500 dark:text-gray-400">Total</p>
            <p className="text-sm font-bold text-brand-600 dark:text-brand-400">{totalAmount.toFixed(2)} oz</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggleTheme} className="rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 dark:text-gray-200">
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </div>
      </header>
      <main className="px-2 py-1 h-[calc(100vh-3rem)] flex gap-2 overflow-hidden">
          {/* Left side - Input and Keypad - Optimized for 800x480 touchscreen */}
          <section className="w-96 rounded-lg bg-white dark:bg-gray-900 shadow-soft p-2 flex flex-col min-h-0">
            {/* Amount input with inline conversion - more compact */}
            <div className="mb-2 flex-shrink-0">
              <label htmlFor="amount" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount</label>
              <div className="flex items-stretch rounded ring-1 ring-gray-300 focus-within:ring-2 focus-within:ring-brand-500 overflow-hidden">
                <input
                  inputMode="decimal"
                  type="text"
                  id="amount"
                  value={amount}
                  readOnly
                  className="flex-1 px-3 py-2 text-xl font-semibold placeholder-gray-300 focus:outline-none bg-transparent text-gray-900 dark:text-gray-100"
                  placeholder="0.0"
                />
                <div className="flex">
                  <button
                    type="button"
                    onClick={() => handleUnitToggle('oz')}
                    className={`px-3 py-2 text-sm font-semibold ${unit === 'oz' ? 'bg-brand-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'} active:scale-95 transition-transform`}
                    aria-pressed={unit === 'oz'}
                  >
                    oz
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUnitToggle('ml')}
                    className={`px-3 py-2 text-sm font-semibold ${unit === 'ml' ? 'bg-brand-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200'} active:scale-95 transition-transform`}
                    aria-pressed={unit === 'ml'}
                  >
                    ml
                  </button>
                </div>
                {/* Inline conversion display */}
                <div className="px-2 py-2 bg-gray-50 dark:bg-gray-800 border-l border-gray-300 dark:border-gray-700 min-w-[4rem] flex items-center justify-center">
                  {amount && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      ≈{unit === 'oz' ? ozToMl(parseFloat(amount)) : mlToOz(parseFloat(amount))}{unit === 'oz' ? 'ml' : 'oz'}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Notes - more compact */}
            <div className="mb-2 flex-shrink-0">
              <label htmlFor="notes" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows="1"
                className="block w-full rounded text-xs border-gray-300 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:ring-brand-500 py-1 px-2"
                placeholder="e.g., Left side, morning"
              />
            </div>

            {/* Large touchscreen keypad - takes remaining space */}
            <div className="flex-1 select-none flex flex-col min-h-0">
              <div className="grid grid-cols-3 gap-2 mb-2 flex-1">
                {[1,2,3,4,5,6,7,8,9].map(n => (
                  <button key={n} onClick={() => appendDigit(String(n))} className="rounded-lg bg-gray-100 dark:bg-gray-800 py-3 text-lg font-bold active:scale-95 min-h-[2.5rem]">{n}</button>
                ))}
                <button onClick={() => appendDigit('.')} className="rounded-lg bg-gray-100 dark:bg-gray-800 py-3 text-lg font-bold active:scale-95 min-h-[2.5rem]">.</button>
                <button onClick={() => appendDigit('0')} className="rounded-lg bg-gray-100 dark:bg-gray-800 py-3 text-lg font-bold active:scale-95 min-h-[2.5rem]">0</button>
                <button onClick={backspace} className="rounded-lg bg-amber-500 text-white py-3 text-lg font-semibold active:scale-95 min-h-[2.5rem]">⌫</button>
              </div>
              {/* Print mode selector */}
              <div className="mb-2 flex items-center gap-2 flex-shrink-0">
                <label className="text-xs text-gray-600 dark:text-gray-300">Print to</label>
                <select value={printMode} onChange={(e) => setPrintMode(e.target.value)} className="text-xs rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1">
                  <option value="agent">Pi Agent</option>
                  <option value="network">Network</option>
                  <option value="device">This Device</option>
                </select>
                {printMode === 'agent' && (
                  <input value={printerId} onChange={(e) => setPrinterId(e.target.value)} placeholder="Printer ID (optional)" className="text-xs rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1 flex-1" />
                )}
                {printMode === 'network' && (
                  <>
                    <input value={netHost} onChange={(e) => setNetHost(e.target.value)} placeholder="Printer IP/Host" className="text-xs rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1 flex-1" />
                    <input type="number" value={netPort} onChange={(e) => setNetPort(Number(e.target.value))} placeholder="9100" className="w-20 text-xs rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1" />
                  </>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 flex-shrink-0">
                <button onClick={clearAll} className="rounded-lg bg-gray-200 dark:bg-gray-700 py-2 text-sm font-semibold active:scale-95 min-h-[2.5rem]">Clear</button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="rounded-lg bg-brand-600 text-white text-sm font-semibold py-2 shadow-soft active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed min-h-[2.5rem]"
                >
                  {submitting ? 'Saving…' : 'Save & Print'}
                </button>
              </div>
            </div>
          </section>

          {/* Right side - Sessions List - Uses remaining width */}
          <section className="flex-1 rounded-lg bg-white dark:bg-gray-900 shadow-soft p-3 flex flex-col min-w-0">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Recent Sessions ({totalMl} ml total)</h2>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ul className="space-y-2">
                {sessions.map((session) => (
                  <li key={session.id} className="relative overflow-hidden">
                    <div className="absolute inset-y-0 right-0 flex items-center gap-2 pr-2 z-10">
                      <button onClick={() => handleLocalPrint(session.id)} className="rounded bg-green-600 text-white px-3 py-2 text-sm font-medium min-h-[2.5rem]">Print</button>
                      <button onClick={() => handleEdit(session.id)} className="rounded bg-blue-600 text-white px-3 py-2 text-sm font-medium min-h-[2.5rem]">Edit</button>
                      <button onClick={() => handleDelete(session.id)} className="rounded bg-red-600 text-white px-3 py-2 text-sm font-medium min-h-[2.5rem]">Del</button>
                    </div>
                    <div
                      id={`row-${session.id}`}
                      onTouchStart={onTouchStart(session.id)}
                      onTouchMove={onTouchMove(session.id)}
                      onTouchEnd={onTouchEnd(session.id)}
                      className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 active:scale-[0.99] transition-transform pr-20 min-h-[4rem]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                            {session.amount_oz.toFixed(2)} oz • {ozToMl(session.amount_oz)} ml
                          </p>
                          <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{new Date(session.timestamp).toLocaleString()}</p>
                          {session.notes && (
                            <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-1">{session.notes}</p>
                          )}
                        </div>
                        <div className="text-right text-sm text-gray-500 dark:text-gray-400 shrink-0">
                          <p className="text-xs">Fridge: {new Date(session.use_by_fridge).toLocaleDateString()}</p>
                          <p className="text-xs">Freeze: {new Date(session.use_by_frozen).toLocaleDateString()}</p>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </main>
    </div>
  );
}

export default App;
