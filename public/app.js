const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;

// ══════════════════════════════════════
// CONFIG STATE
// ══════════════════════════════════════
const defaultConfig = {
  client_name: 'Worksome',
  assistant_name: 'Worksome Hiring Hub',
  branding: {
    logo_text: 'W',
    primary_color: '#1a1d23',
    greeting: "Hi! I'm here to help you find the right talent. Let's get started.",
    logo_url: '',
    hero_image_url: '',
    headline: '',
    subheadline: ''
  },
  vms: {
    name: 'Beeline',
    url: 'https://beeline.com',
    api_type: 'REST'
  },
  worksome_url: 'https://sandbox.worksome.com/login',
  worksome_talent_pool_url: 'https://sandbox.worksome.com/contacts',
  weights: {
    deliverable_or_ongoing: 3,
    duration: 2,
    headcount: 2,
    payment_model: 1,
    sdc: 1
  },
  knockouts: {
    vms: ['agency', 'staffing firm', 'temp workers', 'temps'],
    worksome: ['freelancer', 'independent consultant', 'sow', 'statement of work', 'fixed bid', 'milestone payment']
  },
  approval_gates: [{
    condition: 'spend > 100000',
    action: 'procurement_review'
  }],
  education: {
    policies: [{
      title: 'Classification before engagement',
      body: 'Every contractor must have a completed status assessment before work begins. For UK engagements, this means an IR35 determination (PSC) or employment status analysis (sole trader). For US engagements, federal and state classification review is required. Worksome handles this as part of onboarding — no contractor may start without it.'
    }, {
      title: 'Contract and practice must align',
      body: 'The way you work with a contractor must match what the contract says. Do not include contractors in performance reviews, employee benefits, bonus schemes, or equity plans. Do not direct their daily schedule or provide company equipment. If the scope of work materially changes, a status reassessment is triggered automatically in Worksome.'
    }, {
      title: 'Misclassification risk',
      body: 'Getting classification wrong can result in backdated tax, penalties, and employment claims. In the UK, failure to exercise "reasonable care" on IR35 transfers tax liability to your company. In the US, states like California apply strict ABC tests where the worker is presumed to be an employee unless specific conditions are met. Worksome manages this risk — but your working practices need to support the classification.'
    }, {
      title: 'Long-term engagement reviews',
      body: 'Engagements that run for extended periods are subject to periodic reassessment. The longer a contractor works with you, the higher the risk of employment status drift. Worksome tracks engagement duration and flags reviews automatically. If you need ongoing support beyond 12 months, discuss renewal with your procurement team.'
    }, {
      title: 'When to use each channel',
      body: 'Use Worksome for independent contractors, freelancers, and consultants engaged on defined projects or deliverables. Use Beeline for temporary staff augmentation, agency workers, and roles where you manage day-to-day work directly. If in doubt, this intake tool will route you to the right place.'
    }],
    guides: [{
      title: 'Writing a great project brief',
      body: 'Be specific about deliverables, not just skills. Instead of "need a designer," say "redesign our checkout flow to improve mobile conversion." Include timeline, budget range, and whether the work is remote or on-site. A clear brief leads to better talent matches and faster onboarding.'
    }, {
      title: 'Working with contractors safely',
      body: 'Treat contractors as independent partners, not employees. Define outcomes and deliverables rather than dictating hours or methods. Do not include them in team stand-ups as mandatory attendees or put them on internal org charts. Keep supervision consistent with independent status — this protects both you and the contractor.'
    }, {
      title: 'Onboarding a freelancer',
      body: 'Once routed through Worksome, the contract, compliance checks, and payments are handled for you. Your part: provide a clear project brief, grant access to necessary tools or repos, schedule a kickoff meeting, and assign a primary point of contact on your team.'
    }, {
      title: 'How the intake process works',
      body: 'Describe what you need in plain language. The system asks a few quick questions to understand the type of work, then routes you to the right platform and creates a draft engagement. The whole process takes under 2 minutes. You can also use the AI project brief feature to search your talent pool for the best match.'
    }]
  }
};

// ══════════════════════════════════════
// LIVE ANALYTICS (from the server audit log)
// ══════════════════════════════════════
function useAnalytics() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    fetch('/api/analytics', {
      headers: apiHeaders()
    }).then(r => r.ok ? r.json() : null).then(s => {
      if (s) setStats(s);
    }).catch(() => {});
  }, []);
  return stats;
}

// ══════════════════════════════════════
// API HELPERS (auth + assistant call)
// ══════════════════════════════════════
// Auth is handled by an HttpOnly session cookie issued by the server
// when the page loads — sent automatically on same-origin requests.
function apiHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...extra
  };
}

// Set when a conversation starts — lets the server compute intake duration
let _conversationStartedAt = null;

// Returns { text, intakeId } — intakeId is present once the server has
// recorded a completed routing decision in the audit log.
async function callAssistant(messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      messages: messages.map(m => ({
        role: m.role,
        content: m.text
      })),
      started_at: _conversationStartedAt
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  const data = await res.json();
  return {
    text: data.text,
    intakeId: data.intakeId || null,
    approval: data.approval || null
  };
}

// Streaming variant — renders progressively via onDelta; falls back to
// the non-streaming endpoint if a stream can't be established.
async function callAssistantStream(messages, onDelta) {
  let res;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: messages.map(m => ({
          role: m.role,
          content: m.text
        })),
        started_at: _conversationStartedAt
      })
    });
  } catch {
    return callAssistant(messages);
  }
  if (!res.ok || !res.body) return callAssistant(messages);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '',
    acc = '',
    final = null,
    streamError = null;
  while (true) {
    const {
      done,
      value
    } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {
      stream: true
    });
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const ev of events) {
      const line = ev.trim();
      if (!line.startsWith('data:')) continue;
      let obj = null;
      try {
        obj = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (obj.error) streamError = obj.error;
      if (obj.delta) {
        acc += obj.delta;
        if (onDelta) onDelta(acc);
      }
      if (obj.done) final = obj;
    }
  }
  if (streamError && !final) throw new Error(streamError);
  if (final) return {
    text: final.text,
    intakeId: final.intakeId || null,
    approval: final.approval || null
  };
  return {
    text: acc,
    intakeId: null,
    approval: null
  };
}

// Hide routing JSON / search markers while text is still streaming
function visibleStreamText(t) {
  return t.split('```json')[0].split('[TALENT_SEARCH')[0];
}

// ══════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════
function App() {
  const [page, setPage] = useState('chat');
  const [config, setConfig] = useState(defaultConfig);
  const [configDirty, setConfigDirty] = useState(false);
  const [configStatus, setConfigStatus] = useState(null); // 'saving' | 'saved' | 'error'

  // Server-side config is the source of truth — load it on start
  useEffect(() => {
    fetch('/api/config', {
      headers: apiHeaders()
    }).then(r => r.ok ? r.json() : null).then(serverCfg => {
      if (serverCfg) setConfig(prev => ({
        ...prev,
        ...serverCfg
      }));
    }).catch(() => {}); // fall back to defaults if unreachable
  }, []);
  const updateConfig = useCallback(updates => {
    setConfig(prev => ({
      ...prev,
      ...updates
    }));
    setConfigDirty(true);
    setConfigStatus(null);
  }, []);
  const saveConfig = useCallback(async cfg => {
    setConfigStatus('saving');
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify(cfg)
      });
      if (!res.ok) throw new Error('save failed');
      const saved = await res.json();
      setConfig(prev => ({
        ...prev,
        ...saved
      }));
      setConfigDirty(false);
      setConfigStatus('saved');
    } catch {
      setConfigStatus('error');
    }
  }, []);
  const accentStyle = {
    '--accent': config.branding.primary_color,
    '--accent-bg': config.branding.primary_color + '18',
    '--accent-hover': config.branding.primary_color + 'dd'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      ...accentStyle,
      height: '100vh',
      display: 'flex',
      flexDirection: 'column'
    }
  }, page === 'chat' ? /*#__PURE__*/React.createElement(ChatPage, {
    config: config,
    setPage: setPage,
    page: page
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Nav, {
    page: page,
    setPage: setPage,
    config: config
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'hidden'
    }
  }, page === 'config' && /*#__PURE__*/React.createElement(ConfigPage, {
    config: config,
    updateConfig: updateConfig,
    saveConfig: saveConfig,
    configDirty: configDirty,
    configStatus: configStatus
  }), page === 'analytics' && /*#__PURE__*/React.createElement(AnalyticsPage, {
    config: config
  }))));
}

// ══════════════════════════════════════
// NAV
// ══════════════════════════════════════
function Nav({
  page,
  setPage,
  config
}) {
  const tabs = [{
    id: 'chat',
    label: 'Intake',
    icon: '💬'
  }, {
    id: 'analytics',
    label: 'Analytics',
    icon: '📊'
  }, {
    id: 'config',
    label: 'Settings',
    icon: '⚙️'
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "nav-bar",
    style: {
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 52
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      cursor: 'pointer'
    },
    onClick: () => setPage('chat')
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      background: config.branding.primary_color,
      borderRadius: 7,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
      color: 'white',
      fontWeight: 700
    }
  }, config.branding.logo_text), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600
    }
  }, config.assistant_name)), /*#__PURE__*/React.createElement("div", {
    className: "nav-tabs",
    style: {
      display: 'flex',
      gap: 2
    }
  }, tabs.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => setPage(t.id),
    style: {
      fontFamily: 'var(--font)',
      fontSize: 13,
      fontWeight: 500,
      padding: '6px 14px',
      border: 'none',
      borderRadius: 'var(--radius)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: page === t.id ? 'var(--accent-bg)' : 'transparent',
      color: page === t.id ? 'var(--accent)' : 'var(--text-2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, t.icon), " ", /*#__PURE__*/React.createElement("span", {
    className: "nav-label"
  }, t.label)))));
}

// ══════════════════════════════════════
// QUICK-REPLY DETECTION
// ══════════════════════════════════════
function detectQuickReplies(text) {
  const t = text.toLowerCase();
  if (t.includes('already know who') || t.includes('know who you\'d like')) return ['Yes, I have someone in mind', 'No, I need to find someone'];
  if (t.includes('worked with') && (t.includes('before') || t.includes('through us'))) return ['Yes, they\'ve worked with us before', 'No, they\'re new'];
  if ((t.includes('replacing someone') || t.includes('replace someone')) && (t.includes('project') || t.includes('specific'))) return ['Replacing someone on my team', 'Coming in for a specific project'];
  if (t.includes('managing their day-to-day') || t.includes('managing this person') || t.includes('supervising their schedule') || t.includes('directing how')) return ['Yes, I\'ll manage them directly', 'No, they\'ll work independently'];
  if (t.includes('project brief') && (t.includes('ai') || t.includes('talent pool') || t.includes('best match'))) return ['Yes, create a project brief', 'No, I\'ll just describe the role'];
  if ((t.includes('specific project') || t.includes('defined deliverable')) && (t.includes('ongoing support') || t.includes('ongoing'))) return ['Specific project with a deliverable', 'Ongoing support for my team'];
  if (t.includes('prefer to pay') && (t.includes('deliverable') || t.includes('hourly'))) return ['Pay for deliverables / milestones', 'Hourly or daily rate'];
  // Enrichment quick replies
  if (t.includes('remote') && t.includes('on-site') || t.includes('remote') && t.includes('hybrid')) return ['Remote', 'On-site', 'Hybrid'];
  if (t.includes('budget') && t.includes('rate') && t.includes('mind')) return ['I have a budget in mind', 'No specific budget yet'];
  return null;
}

// ══════════════════════════════════════
// LEFT PANEL (Branding)
// ══════════════════════════════════════
function LeftPanel({
  config,
  setPage,
  onLogoClick
}) {
  const [panelTab, setPanelTab] = useState('resources');
  const [expandedCard, setExpandedCard] = useState(null);
  const stats = useAnalytics();
  const worksomeCount = stats ? stats.worksome : 0;
  const vmsCount = stats ? stats.vms : 0;
  const totalRequests = stats ? stats.total : 0;
  const avgSec = stats && stats.avgDurationSeconds ? stats.avgDurationSeconds : null;
  const recentThree = stats ? stats.recent.slice(0, 3) : [];
  const hasHero = config.branding.hero_image_url && config.branding.hero_image_url.trim();
  const hasLogo = config.branding.logo_url && config.branding.logo_url.trim();
  const edu = config.education || {
    policies: [],
    guides: []
  };
  const headline = config.branding.headline || `Welcome back to\n${config.assistant_name}`;
  const subheadline = config.branding.subheadline || 'Your single front door for hiring. Describe what you need and we\'ll route you to the right place.';
  const GridCard = ({
    item,
    idx,
    icon
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      background: expandedCard === idx ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)',
      borderRadius: 8,
      border: '1px solid rgba(255,255,255,0.08)',
      cursor: 'pointer',
      transition: 'background 0.2s'
    },
    onClick: () => setExpandedCard(expandedCard === idx ? null : idx)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 11px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      flexShrink: 0,
      marginTop: 1
    }
  }, icon), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      fontWeight: 500,
      color: 'rgba(255,255,255,0.85)',
      lineHeight: 1.35
    }
  }, item.title)));

  // Find the currently expanded item for the modal
  const expandedItem = (() => {
    if (!expandedCard) return null;
    const type = expandedCard[0];
    const idx = parseInt(expandedCard.slice(1));
    if (type === 'p' && edu.policies[idx]) return {
      ...edu.policies[idx],
      icon: '\u{1F4CB}'
    };
    if (type === 'g' && edu.guides[idx]) return {
      ...edu.guides[idx],
      icon: '\u{1F4A1}'
    };
    return null;
  })();
  return /*#__PURE__*/React.createElement("div", {
    className: "left-panel",
    style: {
      width: '42%',
      minWidth: 360,
      background: '#18181b',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '36px 44px',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'radial-gradient(ellipse at 20% 0%, rgba(107,63,160,0.15) 0%, transparent 60%)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      position: 'absolute',
      top: 36,
      left: 44,
      right: 44,
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      cursor: 'pointer'
    },
    onClick: onLogoClick
  }, hasLogo ? /*#__PURE__*/React.createElement("img", {
    src: config.branding.logo_url,
    alt: config.client_name,
    style: {
      height: 28,
      objectFit: 'contain'
    }
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      background: 'white',
      borderRadius: 8,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 15,
      color: config.branding.primary_color,
      fontWeight: 800
    }
  }, config.branding.logo_text), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 700,
      color: 'white',
      letterSpacing: -0.3
    }
  }, config.client_name || 'worksome'))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost btn-sm",
    style: {
      color: 'rgba(255,255,255,0.5)',
      fontSize: 12
    },
    onClick: () => setPage('analytics')
  }, "Analytics"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost btn-sm",
    style: {
      color: 'rgba(255,255,255,0.5)',
      fontSize: 12
    },
    onClick: () => setPage('config')
  }, "Settings"))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 32,
      fontWeight: 700,
      lineHeight: 1.15,
      marginBottom: 14,
      color: 'white',
      letterSpacing: -0.5,
      whiteSpace: 'pre-line'
    }
  }, headline), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      color: 'rgba(255,255,255,0.55)',
      lineHeight: 1.65,
      marginBottom: 24,
      maxWidth: 340
    }
  }, subheadline)), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1
    }
  }, hasHero ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: config.branding.hero_image_url,
    alt: "Hero",
    style: {
      width: '100%',
      maxWidth: 360,
      borderRadius: 14,
      boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
      objectFit: 'cover'
    }
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      maxWidth: 340
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      background: 'rgba(255,255,255,0.05)',
      borderRadius: 8,
      padding: 3
    }
  }, [{
    id: 'resources',
    label: 'Resources'
  }, {
    id: 'activity',
    label: 'Activity'
  }].map(tab => /*#__PURE__*/React.createElement("button", {
    key: tab.id,
    onClick: () => {
      setExpandedCard(null);
      setPanelTab(tab.id);
    },
    style: {
      flex: 1,
      fontFamily: 'var(--font)',
      fontSize: 11,
      fontWeight: 600,
      padding: '7px 0',
      border: 'none',
      borderRadius: 6,
      cursor: 'pointer',
      letterSpacing: 0.3,
      textTransform: 'uppercase',
      transition: 'all 0.15s',
      background: panelTab === tab.id ? 'rgba(255,255,255,0.12)' : 'transparent',
      color: panelTab === tab.id ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)'
    }
  }, tab.label))), panelTab === 'resources' && /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 360,
      overflowY: 'auto'
    }
  }, edu.policies.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      color: 'rgba(255,255,255,0.4)',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      padding: '4px 0 6px'
    }
  }, "Policies"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 5
    }
  }, edu.policies.map((p, i) => /*#__PURE__*/React.createElement(GridCard, {
    key: 'p' + i,
    item: p,
    idx: 'p' + i,
    icon: "\uD83D\uDCCB"
  })))), edu.guides.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      color: 'rgba(255,255,255,0.4)',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      padding: '10px 0 6px'
    }
  }, "How-to guides"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 5
    }
  }, edu.guides.map((g, i) => /*#__PURE__*/React.createElement(GridCard, {
    key: 'g' + i,
    item: g,
    idx: 'g' + i,
    icon: "\uD83D\uDCA1"
  })))), edu.policies.length === 0 && edu.guides.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      textAlign: 'center',
      color: 'rgba(255,255,255,0.3)',
      fontSize: 12
    }
  }, "No resources configured yet. Add policies and guides in Settings.")), panelTab === 'activity' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(255,255,255,0.07)',
      borderRadius: 12,
      padding: '16px 18px',
      border: '1px solid rgba(255,255,255,0.08)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: 'rgba(255,255,255,0.7)',
      textTransform: 'uppercase',
      letterSpacing: 0.5
    }
  }, "Recent requests"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#a78bfa',
      fontWeight: 600
    }
  }, totalRequests, " total")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, recentThree.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'rgba(255,255,255,0.35)'
    }
  }, "No requests yet \u2014 complete an intake to see activity here."), recentThree.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 26,
      height: 26,
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.1)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      fontWeight: 600,
      color: 'rgba(255,255,255,0.6)'
    }
  }, r.role[0]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'rgba(255,255,255,0.85)'
    }
  }, r.role)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 10,
      background: r.route === 'worksome' ? 'rgba(167,139,250,0.2)' : 'rgba(251,191,36,0.2)',
      color: r.route === 'worksome' ? '#c4b5fd' : '#fbbf24'
    }
  }, r.route === 'worksome' ? 'Worksome' : config.vms.name))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, [{
    value: worksomeCount,
    label: 'Worksome',
    color: '#a78bfa'
  }, {
    value: vmsCount,
    label: config.vms.name,
    color: '#fbbf24'
  }, {
    value: avgSec ? avgSec + 's' : '—',
    label: 'Avg. time',
    color: 'white'
  }].map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      background: 'rgba(255,255,255,0.07)',
      borderRadius: 10,
      padding: '12px 10px',
      border: '1px solid rgba(255,255,255,0.08)',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 700,
      color: s.color
    }
  }, s.value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: 'rgba(255,255,255,0.4)',
      marginTop: 3,
      textTransform: 'uppercase',
      letterSpacing: 0.3
    }
  }, s.label))))))), expandedItem && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      zIndex: 10,
      borderRadius: 'inherit'
    },
    onClick: () => setExpandedCard(null)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '50%',
      left: 44,
      right: 44,
      transform: 'translateY(-50%)',
      zIndex: 11,
      background: '#28282d',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 12,
      padding: '20px 22px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.6)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, expandedItem.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: 'rgba(255,255,255,0.95)'
    }
  }, expandedItem.title)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      color: 'rgba(255,255,255,0.3)',
      cursor: 'pointer',
      lineHeight: 1
    },
    onClick: () => setExpandedCard(null)
  }, "\xD7")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: 'rgba(255,255,255,0.65)',
      lineHeight: 1.7,
      margin: 0
    }
  }, expandedItem.body))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 36,
      left: 44,
      fontSize: 12,
      color: 'rgba(255,255,255,0.2)',
      zIndex: 1
    }
  }, "Powered by Worksome"));
}

// ══════════════════════════════════════
// CHAT PAGE (split layout)
// ══════════════════════════════════════
function ChatPage({
  config,
  setPage,
  page
}) {
  const [messages, setMessages] = useState([]);
  const [apiMessages, setApiMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [routeResult, setRouteResult] = useState(null);
  const [handoffResult, setHandoffResult] = useState(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(null);
  const [quickReplies, setQuickReplies] = useState(null);
  const [waitingForWorkerName, setWaitingForWorkerName] = useState(false);
  const [foundWorkers, setFoundWorkers] = useState([]);
  const [listening, setListening] = useState(false);
  const [ghDiscovery, setGhDiscovery] = useState(null); // { criteria, sessionId } when active
  const [approvalGate, setApprovalGate] = useState(null); // { action, condition, approved? } when a gate fires
  const pendingHandoffRef = useRef(null); // handoff payload held until approval
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const scrollBottom = () => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  };
  const triggerHandoff = payload => {
    setHandoffLoading(true);
    fetch('/api/handoff/worksome', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(payload)
    }).then(r => r.json()).then(h => {
      setHandoffResult(h);
      setHandoffLoading(false);
    }).catch(() => setHandoffLoading(false));
  };
  const approveAndContinue = () => {
    setApprovalGate(g => g ? {
      ...g,
      approved: true
    } : g);
    if (pendingHandoffRef.current) {
      triggerHandoff(pendingHandoffRef.current);
      pendingHandoffRef.current = null;
    }
  };
  useEffect(() => {
    scrollBottom();
  }, [messages, loading]);

  // Speech recognition setup
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognitionRef.current = recognition;
    recognition.onstart = () => setListening(true);
    recognition.onresult = e => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
      setInput(transcript);
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.start();
  };
  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  };

  // Check if the last assistant message was asking for the worker's name
  const isAskingForName = text => {
    const t = text.toLowerCase();
    return t.includes("what's their name") || t.includes("what is their name") || t.includes("who is it") || t.includes("what's the person's name");
  };

  // Search Worksome talent pool by name
  const searchTalentPool = async name => {
    try {
      const res = await fetch(`/api/search-worker?name=${encodeURIComponent(name)}`, {
        headers: apiHeaders()
      });
      const data = await res.json();
      return data.workers || [];
    } catch {
      return [];
    }
  };

  // Search Worksome talent pool by skills
  const searchTalentPoolBySkills = async skillsText => {
    try {
      const res = await fetch(`/api/search-skills?skills=${encodeURIComponent(skillsText)}`, {
        headers: apiHeaders()
      });
      const data = await res.json();
      return data;
    } catch {
      return {
        workers: [],
        resolvedSkills: []
      };
    }
  };
  const sendToAssistant = async (userText, allApiMsgs) => {
    // API key is managed server-side
    setLoading(true);
    setError(null);
    setQuickReplies(null);
    let msgsToSend = allApiMsgs;

    // If we were waiting for a worker name, search the talent pool first
    if (waitingForWorkerName && userText) {
      setWaitingForWorkerName(false);
      const workers = await searchTalentPool(userText);

      // Inject search results: add an assistant "ack" then a user "system" message to maintain alternating roles
      if (workers.length > 0) {
        setFoundWorkers(workers); // Store for handoff
        const workerList = workers.map(w => `- ${w.name}${w.title ? ` (${w.title})` : ''} [ID: ${w.id}]`).join('\n');
        msgsToSend = [...allApiMsgs, {
          role: 'assistant',
          text: `Let me check the talent pool for "${userText}"...`
        }, {
          role: 'user',
          text: `[SYSTEM: Talent pool search results for "${userText}":\n${workerList}\nPresent these matches to the manager and ask them to confirm which worker. IMPORTANT: When outputting the final JSON, you MUST include the worker's ID exactly as shown above in the worker_id field.]`
        }];
      } else {
        msgsToSend = [...allApiMsgs, {
          role: 'assistant',
          text: `Let me check the talent pool for "${userText}"...`
        }, {
          role: 'user',
          text: `[SYSTEM: Talent pool search for "${userText}" returned no results. Tell the manager you couldn't find them but you can get them set up. Ask for their first name to start collecting details (first name, last name, email, country, skills) — one question at a time.]`
        }];
      }
    }
    try {
      // Stream the reply into a placeholder bubble for perceived speed
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: '',
        time: new Date(),
        isStreamingMsg: true
      }]);
      const {
        text: reply,
        intakeId,
        approval: approvalInfo
      } = await callAssistantStream(msgsToSend, acc => {
        const visible = visibleStreamText(acc);
        setMessages(prev => prev.map(m => m.isStreamingMsg ? {
          ...m,
          text: visible
        } : m));
      });
      setMessages(prev => prev.filter(m => !m.isStreamingMsg));
      const jsonMatch = reply.match(/```json\s*([\s\S]*?)```/);
      let cleanReply = reply;
      if (jsonMatch) {
        cleanReply = reply.replace(/```json[\s\S]*?(?:```|$)/, '').trim();
        try {
          const parsed = JSON.parse(jsonMatch[1]);

          // Inject worker_id from search results if the model didn't include it
          if (parsed.known_worker && !parsed.worker_id && foundWorkers.length > 0) {
            // Try to match by name
            const match = foundWorkers.find(w => parsed.worker_name && w.name && w.name.toLowerCase().includes(parsed.worker_name.toLowerCase())) || foundWorkers[0];
            if (match) {
              parsed.worker_id = match.id;
              parsed.worker_email = parsed.worker_email || match.email;
              console.log('[Front Door] Injected worker_id from search:', match.id);
            }
          }
          setRouteResult(parsed);

          // Approval gate: hold the handoff until approved
          if (approvalInfo && approvalInfo.required) setApprovalGate(approvalInfo);

          // Trigger Worksome handoff if routed there
          if (parsed.route === 'worksome') {
            if (approvalInfo && approvalInfo.required) {
              pendingHandoffRef.current = {
                ...parsed,
                _intakeId: intakeId
              };
            } else {
              triggerHandoff({
                ...parsed,
                _intakeId: intakeId
              });
            }

            // Auto-search talent pool if skills are present and no TALENT_SEARCH marker
            const hasSearchMarker = reply.match(/\[TALENT_SEARCH:/);
            if (!hasSearchMarker && parsed.skills && parsed.skills.length > 0) {
              // Always trigger GitHub Discovery alongside Worksome search
              const ghCriteria = {
                skills: parsed.skills,
                languages: [],
                keywords: parsed.skills,
                location: parsed.location || null,
                roleTitle: parsed.role_title || ''
              };
              setGhDiscovery({
                criteria: ghCriteria,
                sessionId: 'default'
              });
              try {
                setMessages(prev => [...prev, {
                  role: 'assistant',
                  text: '🔍 Searching your talent pool...',
                  time: new Date(),
                  isSearching: true
                }]);
                const result = await searchTalentPoolBySkills(parsed.skills.join(', '));
                const workers = result.workers || [];
                setMessages(prev => prev.filter(m => !m.isSearching));
                if (workers.length > 0) {
                  setFoundWorkers(workers);
                  console.log('[Front Door] Auto talent search found', workers.length, 'workers');
                }
              } catch (e) {
                setMessages(prev => prev.filter(m => !m.isSearching));
                console.log('[Front Door] Auto talent search error:', e);
              }
            }
          }
        } catch {}
      }

      // Check for [TALENT_SEARCH: ...] marker — auto-search talent pool
      const talentSearchMatch = reply.match(/\[TALENT_SEARCH:\s*([^\]]+)\]/);
      if (talentSearchMatch) {
        const skillsText = talentSearchMatch[1].trim();
        const displayReply = reply.replace(/\[TALENT_SEARCH:[^\]]+\]/, '').trim();

        // Show the project description part immediately
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: displayReply,
          time: new Date()
        }]);
        // Add a searching indicator
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: '🔍 Searching your talent pool...',
          time: new Date(),
          isSearching: true
        }]);

        // Search the talent pool by the extracted skills
        const result = await searchTalentPoolBySkills(skillsText);
        const workers = result.workers || [];
        const resolved = result.resolvedSkills || [];
        const skillSummary = resolved.map(s => s.name).join(', ') || skillsText;

        // Remove the searching indicator
        setMessages(prev => prev.filter(m => !m.isSearching));

        // Build the follow-up assistant call with results
        const updatedApiMsgs = [...msgsToSend, {
          role: 'assistant',
          text: reply
        }];
        let followUpMsgs;

        // Always trigger GitHub Discovery for external profiles
        const ghCriteria = {
          skills: resolved.map(s => s.name),
          languages: [],
          keywords: skillsText.split(',').map(s => s.trim()).filter(Boolean),
          location: null,
          roleTitle: ''
        };
        console.log('[Front Door] Setting ghDiscovery with criteria:', ghCriteria);
        setGhDiscovery({
          criteria: ghCriteria,
          sessionId: 'default'
        });
        if (workers.length > 0) {
          setFoundWorkers(workers);
          const workerList = workers.map(w => `- ${w.name}${w.title ? ` (${w.title})` : ''}${w.skills && w.skills.length > 0 ? ` | Skills: ${w.skills.join(', ')}` : ''} [ID: ${w.id}]`).join('\n');
          followUpMsgs = [...updatedApiMsgs, {
            role: 'user',
            text: `[SYSTEM: Talent pool search for skills "${skillSummary}" found these workers:\n${workerList}\n\nI've also opened a GitHub Discovery panel showing external technical profiles that match.\n\nScore each internal worker out of 10 based on how well their skills and title match the project requirements you just described. Present results as a ranked list with name, title, skills, score out of 10, and a brief reason. Mention that you've also found external GitHub profiles they can review in the panel below. Then ask if the manager wants to hire one of the internal matches or explore the external candidates. IMPORTANT: Include the worker's ID in worker_id in the final JSON if they pick someone.]`
          }];
        } else {
          followUpMsgs = [...updatedApiMsgs, {
            role: 'user',
            text: `[SYSTEM: Talent pool search for skills "${skillSummary}" found no matches in the internal pool. I've opened a GitHub Discovery panel showing external technical profiles that match. Tell the manager you didn't find anyone in their Worksome talent pool, but you've found some external GitHub profiles with relevant public work. They can review, shortlist, and draft an invite to bring them onto Worksome. Also offer to set up the role so they can find the right person through other channels. Continue to Path B2 Q3 onward — you already have the project description and skills.]`
          }];
        }

        // Second assistant call with results (streamed)
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: '',
          time: new Date(),
          isStreamingMsg: true
        }]);
        const {
          text: followUpReply,
          intakeId: followUpIntakeId,
          approval: followUpApproval
        } = await callAssistantStream(followUpMsgs, acc => {
          const visible = visibleStreamText(acc);
          setMessages(prev => prev.map(m => m.isStreamingMsg ? {
            ...m,
            text: visible
          } : m));
        });
        setMessages(prev => prev.filter(m => !m.isStreamingMsg));
        const followUpJson = followUpReply.match(/```json\s*([\s\S]*?)```/);
        let followUpClean = followUpReply;
        if (followUpJson) {
          followUpClean = followUpReply.replace(/```json[\s\S]*?(?:```|$)/, '').trim();
          try {
            const parsed = JSON.parse(followUpJson[1]);
            if (parsed.known_worker && !parsed.worker_id && foundWorkers.length > 0) {
              const match = foundWorkers.find(w => parsed.worker_name && w.name && w.name.toLowerCase().includes(parsed.worker_name.toLowerCase())) || foundWorkers[0];
              if (match) {
                parsed.worker_id = match.id;
                parsed.worker_email = parsed.worker_email || match.email;
              }
            }
            setRouteResult(parsed);
            if (followUpApproval && followUpApproval.required) setApprovalGate(followUpApproval);
            if (parsed.route === 'worksome') {
              if (followUpApproval && followUpApproval.required) {
                pendingHandoffRef.current = {
                  ...parsed,
                  _intakeId: followUpIntakeId
                };
              } else {
                triggerHandoff({
                  ...parsed,
                  _intakeId: followUpIntakeId
                });
              }
            }
          } catch {}
        }
        setMessages(prev => [...prev.filter(m => !m.isSearching), {
          role: 'assistant',
          text: followUpClean,
          time: new Date()
        }]);
        setApiMessages(prev => [...prev, {
          role: 'assistant',
          text: reply
        }, {
          role: 'user',
          text: followUpMsgs[followUpMsgs.length - 1].text
        }, {
          role: 'assistant',
          text: followUpReply
        }]);
        if (!followUpJson) {
          const qr = detectQuickReplies(followUpClean);
          if (qr) setQuickReplies(qr);
        }
      } else {
        // Normal flow — no talent search marker
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: cleanReply,
          time: new Date()
        }]);
        setApiMessages(prev => [...prev, {
          role: 'assistant',
          text: reply
        }]);
        if (!jsonMatch) {
          const qr = detectQuickReplies(cleanReply);
          if (qr) setQuickReplies(qr);

          // Detect if the assistant is asking for the worker's name
          if (isAskingForName(cleanReply)) {
            setWaitingForWorkerName(true);
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.filter(m => !m.isStreamingMsg));
      setError(err.message);
    }
    setLoading(false);
  };
  const startConversation = () => {
    _conversationStartedAt = Date.now();
    setStarted(true);
    setMessages([]);
    setApiMessages([]);
    setRouteResult(null);
    setError(null);
    const greeting = config.branding.greeting;
    const firstQ = "\n\nDo you already know who you'd like to work with?";
    const fullMsg = greeting + firstQ;
    setMessages([{
      role: 'assistant',
      text: fullMsg,
      time: new Date()
    }]);
    setApiMessages([{
      role: 'assistant',
      text: fullMsg
    }]);
    setQuickReplies(['Yes, I have someone in mind', 'No, I need to find someone']);
  };
  const handleSend = overrideText => {
    const text = (overrideText || input).trim();
    if (!text || loading || routeResult) return;
    setInput('');
    setQuickReplies(null);
    const newUserMsg = {
      role: 'user',
      text,
      time: new Date()
    };
    const newApiMsgs = [...apiMessages, {
      role: 'user',
      text
    }];
    setMessages(prev => [...prev, newUserMsg]);
    setApiMessages(newApiMsgs);
    sendToAssistant(text, newApiMsgs);
  };
  const resetChat = () => {
    setStarted(false);
    setMessages([]);
    setApiMessages([]);
    setRouteResult(null);
    setHandoffResult(null);
    setHandoffLoading(false);
    setError(null);
    setQuickReplies(null);
    setWaitingForWorkerName(false);
    setListening(false);
    setFoundWorkers([]);
    setGhDiscovery(null);
    setApprovalGate(null);
    pendingHandoffRef.current = null;
    _conversationStartedAt = null;
    if (recognitionRef.current) recognitionRef.current.stop();
  };
  const now = d => d ? d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  }) : '';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100vh',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(LeftPanel, {
    config: config,
    setPage: setPage,
    onLogoClick: resetChat
  }), /*#__PURE__*/React.createElement("div", {
    className: "chat-right",
    style: {
      flex: 1,
      background: '#f4f4f5',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "chat-card",
    style: {
      width: '100%',
      maxWidth: 480,
      height: '88vh',
      maxHeight: 660,
      background: 'white',
      borderRadius: 20,
      boxShadow: '0 12px 48px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.04)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.06)'
    }
  }, !started ? /*#__PURE__*/React.createElement("div", {
    className: "chat-start",
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 36px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      background: config.branding.primary_color,
      borderRadius: 12,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 20,
      color: 'white',
      fontWeight: 700,
      margin: '0 auto 16px'
    }
  }, config.branding.logo_text), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 20,
      fontWeight: 700,
      marginBottom: 8
    }
  }, config.assistant_name), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: 'var(--text-2)',
      marginBottom: 28,
      lineHeight: 1.6
    }
  }, "Describe what you need and we'll get you set up with the right team or platform."), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    style: {
      fontSize: 14,
      padding: '11px 28px',
      background: config.branding.primary_color,
      color: 'white',
      border: 'none',
      borderRadius: 8
    },
    onClick: startConversation
  }, "Start a new request"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 20px',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 26,
      height: 26,
      background: config.branding.primary_color,
      borderRadius: 7,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      color: 'white',
      fontWeight: 700,
      cursor: 'pointer'
    },
    onClick: resetChat
  }, config.branding.logo_text), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600
    }
  }, routeResult ? `Routed → ${routeResult.route === 'worksome' ? 'Worksome' : config.vms.name}` : 'Intake in progress')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: resetChat,
    style: {
      fontSize: 12
    }
  }, "New"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: () => setPage('analytics'),
    style: {
      fontSize: 12
    }
  }, "\uD83D\uDCCA"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: () => setPage('config'),
    style: {
      fontSize: 12
    }
  }, "\u2699\uFE0F"))), /*#__PURE__*/React.createElement("div", {
    ref: chatRef,
    className: "chat-messages",
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, messages.filter(m => !(m.isStreamingMsg && !m.text)).map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: `chat-msg ${m.role}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "chat-avatar",
    style: {
      background: m.role === 'assistant' ? config.branding.primary_color : '#4a90d9',
      width: 28,
      height: 28,
      fontSize: 11
    }
  }, m.role === 'assistant' ? config.branding.logo_text : 'You'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "chat-bubble",
    style: {
      whiteSpace: 'pre-wrap'
    }
  }, m.text), /*#__PURE__*/React.createElement("div", {
    className: "chat-time"
  }, now(m.time))))), loading && !messages.some(m => m.isStreamingMsg && m.text) && /*#__PURE__*/React.createElement("div", {
    className: "chat-msg assistant"
  }, /*#__PURE__*/React.createElement("div", {
    className: "chat-avatar",
    style: {
      background: config.branding.primary_color,
      width: 28,
      height: 28,
      fontSize: 11
    }
  }, config.branding.logo_text), /*#__PURE__*/React.createElement("div", {
    className: "chat-bubble"
  }, /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }), ' ', /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }), ' ', /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }))), error && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--red-bg)',
      border: '1px solid var(--red)',
      borderRadius: 'var(--radius)',
      padding: '10px 14px',
      fontSize: 13,
      color: 'var(--red)'
    }
  }, error), foundWorkers.length > 0 && /*#__PURE__*/React.createElement(WorksomeTalentPanel, {
    workers: foundWorkers,
    onHire: worker => {
      // Simulate the user selecting this worker
      handleSend(`I'd like to hire ${worker.name}`);
    },
    onClose: () => setFoundWorkers([]),
    routeResult: routeResult
  }), ghDiscovery && /*#__PURE__*/React.createElement(GitHubDiscoveryPanel, {
    criteria: ghDiscovery.criteria,
    sessionId: ghDiscovery.sessionId,
    config: config,
    onClose: () => setGhDiscovery(null)
  }), quickReplies && !loading && !routeResult && /*#__PURE__*/React.createElement("div", {
    className: "chat-options",
    style: {
      marginLeft: 38
    }
  }, quickReplies.map((qr, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    className: "chat-option",
    onClick: () => handleSend(qr)
  }, qr))), routeResult && (() => {
    const isWorksome = routeResult.route === 'worksome';
    const dest = isWorksome ? 'Worksome' : config.vms.name;
    const color = isWorksome ? 'var(--accent)' : 'var(--warn)';

    // Determine the best URL to link to
    let destUrl = isWorksome ? config.worksome_url : config.vms.url;
    if (isWorksome && handoffResult && handoffResult.job_url) {
      destUrl = handoffResult.job_url;
    }
    // Worker not found but details collected — send to trusted contacts to invite
    const isNewWorker = isWorksome && routeResult.worker_found === false && routeResult.worker_email;
    // Worker not found and no details — fallback to talent pool
    const isRedirect = isWorksome && routeResult.worker_found === false && !routeResult.worker_email;
    if (isRedirect) {
      destUrl = config.worksome_talent_pool_url || config.worksome_url;
    }
    return /*#__PURE__*/React.createElement("div", {
      className: `route-card ${isWorksome ? 'worksome' : 'vms'}`
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color,
        marginBottom: 4
      }
    }, "Routed \u2192 ", dest), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 15,
        fontWeight: 600,
        marginBottom: 4
      }
    }, routeResult.role_title || 'Role'), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: 'var(--text-2)',
        marginBottom: 10,
        lineHeight: 1.5
      }
    }, isNewWorker ? `Click below to invite ${routeResult.worker_first_name || routeResult.worker_name || 'your worker'} ${routeResult.worker_last_name || ''} to the talent pool` : isRedirect ? `Search the talent pool for ${routeResult.worker_name || 'your worker'}` : /*#__PURE__*/React.createElement(React.Fragment, null, "Confidence: ", routeResult.confidence, " \xB7 ", routeResult.known_worker ? 'Known worker' : 'Talent search', routeResult.headcount > 1 ? ` · ${routeResult.headcount} people` : '')), isWorksome && handoffLoading && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: 'var(--text-3)',
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "typing-dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "typing-dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "typing-dot"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 4
      }
    }, "Creating draft job in Worksome...")), isWorksome && handoffResult && handoffResult.job_id && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: 'var(--accent)',
        marginBottom: 8
      }
    }, "Draft job created in Worksome (ID: ", handoffResult.job_id, ")", handoffResult.worker_invited && handoffResult.worker_name && /*#__PURE__*/React.createElement("span", null, " \xB7 ", handoffResult.worker_name, " invited to talent pool")), !isWorksome && /*#__PURE__*/React.createElement(BeelinePreview, {
      routeResult: routeResult,
      vmsName: config.vms.name,
      approvalGate: approvalGate
    }), approvalGate && !approvalGate.approved ? /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'var(--warn-bg)',
        border: '1px solid var(--warn)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        marginTop: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        fontWeight: 700,
        color: 'var(--warn)',
        marginBottom: 4
      }
    }, "\u23F8 Approval required: ", approvalGate.action.replace(/_/g, ' ')), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: 'var(--text-2)',
        marginBottom: 8
      }
    }, "Rule: ", approvalGate.condition, " \u2014 this request is on hold until approved."), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-sm btn-primary",
      onClick: approveAndContinue
    }, "Approve & continue")) : /*#__PURE__*/React.createElement("a", {
      href: destUrl,
      target: "_blank",
      rel: "noopener",
      style: {
        display: 'inline-block',
        padding: '8px 18px',
        borderRadius: 'var(--radius)',
        fontSize: 13,
        fontWeight: 600,
        color: 'white',
        textDecoration: 'none',
        background: color,
        marginTop: 10
      }
    }, isRedirect ? 'Search talent pool →' : isNewWorker ? 'Invite to talent pool →' : `Continue in ${dest} →`));
  })()), !routeResult && /*#__PURE__*/React.createElement("div", {
    className: "chat-input-bar",
    style: {
      padding: '12px 20px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      gap: 8,
      flexShrink: 0,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: listening ? stopListening : startListening,
    disabled: loading,
    title: listening ? 'Stop listening' : 'Voice input',
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      border: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      background: listening ? 'var(--red)' : 'var(--bg)',
      color: listening ? 'white' : 'var(--text-2)',
      transition: 'all 0.2s',
      animation: listening ? 'pulse 1.5s ease-in-out infinite' : 'none'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19 10v2a7 7 0 0 1-14 0v-2"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "12",
    y1: "19",
    x2: "12",
    y2: "23"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "8",
    y1: "23",
    x2: "16",
    y2: "23"
  }))), /*#__PURE__*/React.createElement("input", {
    ref: inputRef,
    className: "input",
    placeholder: listening ? 'Listening...' : 'Or type your answer...',
    value: input,
    onChange: e => setInput(e.target.value),
    onKeyDown: e => e.key === 'Enter' && handleSend(),
    disabled: loading,
    style: {
      borderRadius: 8
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => handleSend(),
    disabled: loading || !input.trim(),
    style: {
      borderRadius: 8
    }
  }, "Send"))))));
}

// ══════════════════════════════════════
// GITHUB DISCOVERY COMPONENTS
// ══════════════════════════════════════

function ExternalTalentCard({
  lead,
  onShortlist,
  onInvite,
  isShortlisted
}) {
  const [expanded, setExpanded] = React.useState(false);
  const scoreClass = lead.fitScore >= 65 ? 'high' : lead.fitScore >= 40 ? 'medium' : 'low';
  const confidenceLabel = lead.confidenceScore >= 70 ? 'High' : lead.confidenceScore >= 45 ? 'Medium' : 'Low';
  const topRepos = (lead.relevantRepositories || []).slice(0, expanded ? 4 : 2);
  const allLangs = lead.topLanguages || [];
  const matchedSkills = lead.inferredSkills || [];
  return /*#__PURE__*/React.createElement("div", {
    className: "gh-card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start'
    }
  }, lead.avatarUrl && /*#__PURE__*/React.createElement("img", {
    src: lead.avatarUrl,
    alt: "",
    style: {
      width: 40,
      height: 40,
      borderRadius: 8,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 14
    }
  }, lead.displayName || lead.githubLogin), /*#__PURE__*/React.createElement("span", {
    className: "gh-badge-source"
  }, "GitHub"), lead.activityRecency && lead.activityRecency !== 'unknown' && /*#__PURE__*/React.createElement("span", {
    className: "badge badge-green",
    style: {
      fontSize: 10
    }
  }, "Active ", lead.activityRecency.replace(/_/g, ' '))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: lead.githubProfileUrl,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: 'var(--text-3)',
      textDecoration: 'none'
    }
  }, "@", lead.githubLogin), lead.location && /*#__PURE__*/React.createElement("span", null, " \xB7 ", lead.location)), lead.bio && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-2)',
      marginTop: 4,
      lineHeight: 1.4
    }
  }, lead.bio.slice(0, 120), lead.bio.length > 120 ? '...' : '')), /*#__PURE__*/React.createElement("div", {
    className: `gh-score ${scoreClass}`,
    title: `Fit: ${lead.fitScore}/100`
  }, lead.fitScore)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 0
    }
  }, matchedSkills.map(s => /*#__PURE__*/React.createElement("span", {
    key: s,
    className: "gh-tag matched"
  }, s)), allLangs.filter(l => !matchedSkills.map(s => s.toLowerCase()).includes(l.toLowerCase())).slice(0, 4).map(l => /*#__PURE__*/React.createElement("span", {
    key: l,
    className: "gh-tag"
  }, l))), topRepos.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, topRepos.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.name,
    className: "gh-repo"
  }, /*#__PURE__*/React.createElement("a", {
    href: r.url,
    target: "_blank",
    rel: "noopener noreferrer"
  }, r.name.split('/').pop()), r.stars > 0 && /*#__PURE__*/React.createElement("span", null, " \xB7 ", r.stars, " stars"), r.language && /*#__PURE__*/React.createElement("span", null, " \xB7 ", r.language)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      fontSize: 11,
      color: 'var(--text-3)'
    }
  }, lead.fitExplanation, " \xB7 Confidence: ", confidenceLabel, " (", lead.confidenceScore, "%)"), expanded && lead.fitBreakdown && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      padding: '8px 10px',
      background: 'var(--bg)',
      borderRadius: 'var(--radius)',
      fontSize: 11,
      color: 'var(--text-2)'
    }
  }, Object.entries(lead.fitBreakdown).map(([key, val]) => /*#__PURE__*/React.createElement("div", {
    key: key,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 2
    }
  }, /*#__PURE__*/React.createElement("span", null, key.replace(/([A-Z])/g, ' $1').trim()), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600
    }
  }, val.weighted, "/", Math.round(val.weight * 100))))), /*#__PURE__*/React.createElement("div", {
    className: "gh-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm ${isShortlisted ? 'btn-ghost' : 'btn-primary'}`,
    onClick: () => !isShortlisted && onShortlist(lead),
    disabled: isShortlisted,
    style: isShortlisted ? {
      opacity: 0.7,
      cursor: 'default'
    } : {}
  }, isShortlisted ? 'Shortlisted' : 'Shortlist'), isShortlisted && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => onInvite(lead)
  }, "Draft invite"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost gh-expand",
    onClick: () => setExpanded(!expanded),
    style: {
      marginLeft: 'auto'
    }
  }, expanded ? 'Less' : 'More')));
}
function GitHubDiscoveryPanel({
  criteria,
  sessionId,
  config,
  onClose
}) {
  const [leads, setLeads] = React.useState([]);
  const [shortlist, setShortlist] = React.useState([]);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [searchError, setSearchError] = React.useState(null);
  const [searched, setSearched] = React.useState(false);
  const [tab, setTab] = React.useState('results'); // results | shortlist
  const [inviteModal, setInviteModal] = React.useState(null); // lead with draft
  const panelRef = React.useRef(null);

  // Scroll panel into view when it renders or when leads arrive
  React.useEffect(() => {
    if (panelRef.current) {
      setTimeout(() => panelRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      }), 100);
    }
  }, [leads, searchLoading]);

  // Auto-search on mount if criteria provided
  React.useEffect(() => {
    console.log('[GitHubDiscovery] Panel mounted, criteria:', criteria);
    if (panelRef.current) {
      panelRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
    if (criteria && (criteria.skills?.length || criteria.languages?.length || criteria.keywords?.length)) {
      console.log('[GitHubDiscovery] Auto-searching...');
      runSearch(criteria);
    }
  }, []);
  const runSearch = async c => {
    setSearchLoading(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams();
      if (c.skills?.length) params.set('skills', c.skills.join(','));
      if (c.languages?.length) params.set('languages', c.languages.join(','));
      if (c.keywords?.length) params.set('keywords', c.keywords.join(','));
      if (c.location) params.set('location', c.location);
      params.set('maxResults', '3');
      const res = await fetch(`/api/github/search?${params}`, {
        headers: apiHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      console.log('[GitHubDiscovery] Search returned', (data.leads || []).length, 'leads');
      setLeads(data.leads || []);
      setSearched(true);
    } catch (err) {
      console.error('[GitHubDiscovery] Search error:', err.message);
      setSearchError(err.message);
    }
    setSearchLoading(false);
  };
  const handleShortlist = async lead => {
    try {
      const res = await fetch('/api/github/shortlist', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          sessionId: sessionId || 'default',
          lead
        })
      });
      const data = await res.json();
      setShortlist(data.shortlist || []);
    } catch (err) {
      console.error('Shortlist error:', err);
    }
  };
  const handleInvite = async lead => {
    try {
      const res = await fetch('/api/github/invite', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          sessionId: sessionId || 'default',
          githubLogin: lead.githubLogin,
          roleTitle: criteria?.roleTitle || 'a technical role',
          skills: lead.inferredSkills,
          clientName: config?.client_name || 'our team',
          senderName: ''
        })
      });
      const data = await res.json();
      setInviteModal({
        lead,
        ...data
      });
    } catch (err) {
      console.error('Invite error:', err);
    }
  };
  const isShortlisted = login => shortlist.some(l => l.githubLogin === login);
  return /*#__PURE__*/React.createElement("div", {
    ref: panelRef,
    className: "gh-panel",
    style: {
      marginTop: 12,
      maxWidth: 500
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "gh-header"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "GitHub Discovery"), searched && /*#__PURE__*/React.createElement("span", {
    className: "badge badge-blue"
  }, leads.length, " found")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm ${tab === 'results' ? '' : 'btn-ghost'}`,
    onClick: () => setTab('results')
  }, "Results"), /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm ${tab === 'shortlist' ? '' : 'btn-ghost'}`,
    onClick: () => setTab('shortlist')
  }, "Shortlist", shortlist.length > 0 ? ` (${shortlist.length})` : ''), onClose && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: onClose,
    title: "Close"
  }, "\xD7"))), criteria && /*#__PURE__*/React.createElement("div", {
    className: "gh-search-bar"
  }, criteria.skills?.map(s => /*#__PURE__*/React.createElement("span", {
    key: s,
    className: "gh-tag matched"
  }, s)), criteria.languages?.map(l => /*#__PURE__*/React.createElement("span", {
    key: l,
    className: "gh-tag"
  }, l)), criteria.location && /*#__PURE__*/React.createElement("span", {
    className: "gh-tag"
  }, criteria.location)), searchLoading && /*#__PURE__*/React.createElement("div", {
    className: "gh-empty"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, "Searching GitHub for talent..."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "typing-dot"
  }))), searchError && /*#__PURE__*/React.createElement("div", {
    className: "gh-empty",
    style: {
      color: 'var(--red)'
    }
  }, searchError.includes('rate limit') ? 'GitHub rate limit reached. Please try again in a few minutes.' : `Search error: ${searchError}`), !searchLoading && !searchError && tab === 'results' && /*#__PURE__*/React.createElement(React.Fragment, null, leads.length === 0 && searched && /*#__PURE__*/React.createElement("div", {
    className: "gh-empty"
  }, "No matching profiles found. Try broader criteria."), leads.map(lead => /*#__PURE__*/React.createElement(ExternalTalentCard, {
    key: lead.id,
    lead: lead,
    onShortlist: handleShortlist,
    onInvite: handleInvite,
    isShortlisted: isShortlisted(lead.githubLogin)
  }))), tab === 'shortlist' && /*#__PURE__*/React.createElement(React.Fragment, null, shortlist.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "gh-empty"
  }, "No one shortlisted yet. Browse results and shortlist candidates to compare."), shortlist.map(lead => /*#__PURE__*/React.createElement(ExternalTalentCard, {
    key: lead.id,
    lead: lead,
    onShortlist: handleShortlist,
    onInvite: handleInvite,
    isShortlisted: true
  }))), inviteModal && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      borderTop: '1px solid var(--border)',
      background: 'var(--accent-bg)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 13
    }
  }, "Invite draft for @", inviteModal.lead.githubLogin), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: () => setInviteModal(null)
  }, "\xD7")), /*#__PURE__*/React.createElement("textarea", {
    className: "input",
    rows: 8,
    defaultValue: inviteModal.inviteMessage,
    style: {
      fontSize: 12,
      lineHeight: 1.5
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    onClick: () => {
      navigator.clipboard.writeText(inviteModal.inviteMessage);
      setInviteModal(null);
    }
  }, "Copy to clipboard"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)'
    }
  }, "Review and personalise before sending"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px',
      borderTop: '1px solid var(--border-light)',
      fontSize: 10,
      color: 'var(--text-3)',
      lineHeight: 1.4
    }
  }, "External profiles from public GitHub data only. No contact info is shared until the candidate creates a Worksome profile."));
}

// ══════════════════════════════════════
// WORKSOME TALENT CARDS
// ══════════════════════════════════════

function WorksomeTalentCard({
  worker,
  onHire,
  selected,
  onToggleSelect
}) {
  const [expanded, setExpanded] = React.useState(false);
  const scoreClass = worker.fitScore >= 65 ? 'high' : worker.fitScore >= 40 ? 'medium' : 'low';
  const initials = (worker.name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const matchedSkills = worker.fitBreakdown?.skillMatch?.reasons || [];
  return /*#__PURE__*/React.createElement("div", {
    className: "ws-card",
    style: {
      border: selected ? '2px solid var(--accent)' : undefined,
      background: selected ? 'var(--accent-bg)' : undefined
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => onToggleSelect && onToggleSelect(worker),
    style: {
      width: 20,
      height: 20,
      borderRadius: 4,
      flexShrink: 0,
      cursor: 'pointer',
      marginTop: 2,
      border: selected ? '2px solid var(--accent)' : '2px solid var(--border)',
      background: selected ? 'var(--accent)' : 'var(--surface)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'all 0.15s'
    },
    title: selected ? 'Deselect' : 'Select for job invite'
  }, selected && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'white',
      fontSize: 12,
      fontWeight: 700
    }
  }, "\u2713")), worker.avatar ? /*#__PURE__*/React.createElement("img", {
    src: worker.avatar,
    alt: "",
    className: "ws-avatar"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "ws-avatar-placeholder"
  }, initials), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 14
    }
  }, worker.name || 'Unknown'), worker.isCurrentlyHired ? /*#__PURE__*/React.createElement("span", {
    className: "ws-status hired"
  }, "On a hire") : worker.previouslyEngaged ? /*#__PURE__*/React.createElement("span", {
    className: "ws-status available"
  }, "Available") : null), worker.title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)',
      marginTop: 2
    }
  }, worker.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)',
      marginTop: 2,
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, worker.location && /*#__PURE__*/React.createElement("span", null, worker.location), worker.dayRate && /*#__PURE__*/React.createElement("span", {
    className: "ws-rate"
  }, worker.currency || '', " ", worker.dayRate, "/day"), worker.previouslyEngaged && /*#__PURE__*/React.createElement("span", null, "Previously engaged"), worker.hiresCount > 0 && /*#__PURE__*/React.createElement("span", {
    title: `${worker.hiresCount} previous hire(s)`
  }, worker.hiresCount, " hire", worker.hiresCount !== 1 ? 's' : ''), worker.notesCount > 0 && /*#__PURE__*/React.createElement("span", {
    title: `${worker.notesCount} internal note(s)`
  }, worker.notesCount, " note", worker.notesCount !== 1 ? 's' : '')), worker.bio && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)',
      marginTop: 4,
      lineHeight: 1.4
    }
  }, worker.bio.slice(0, 140), worker.bio.length > 140 ? '...' : '')), /*#__PURE__*/React.createElement("div", {
    className: `ws-score ${scoreClass}`,
    title: `Fit: ${worker.fitScore}/100`
  }, worker.fitScore)), worker.skills && worker.skills.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 0
    }
  }, worker.skills.map(s => {
    const isCompany = (worker.companySkills || []).some(cs => cs.toLowerCase() === s.toLowerCase());
    const isMatched = matchedSkills.some(m => m.toLowerCase() === s.toLowerCase());
    return /*#__PURE__*/React.createElement("span", {
      key: s,
      className: `ws-tag ${isCompany ? 'company' : isMatched ? 'matched' : ''}`,
      title: isCompany ? 'Added by your company' : ''
    }, s);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      fontSize: 11,
      color: 'var(--text-3)'
    }
  }, worker.fitExplanation), expanded && worker.fitBreakdown && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      padding: '8px 10px',
      background: 'var(--bg)',
      borderRadius: 'var(--radius)',
      fontSize: 11
    }
  }, Object.entries(worker.fitBreakdown).map(([key, val]) => /*#__PURE__*/React.createElement("div", {
    key: key,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 110,
      color: 'var(--text-3)',
      flexShrink: 0
    }
  }, key.replace(/([A-Z])/g, ' $1').trim()), /*#__PURE__*/React.createElement("div", {
    className: "ws-breakdown-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ws-breakdown-fill",
    style: {
      width: `${val.score}%`,
      background: val.score >= 65 ? '#22c55e' : val.score >= 40 ? '#f59e0b' : '#ef4444'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: 'var(--text-2)',
      width: 30,
      textAlign: 'right'
    }
  }, val.weighted)))), expanded && worker.hires && worker.hires.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      padding: '8px 10px',
      background: 'var(--bg)',
      borderRadius: 'var(--radius)',
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      marginBottom: 4,
      color: 'var(--text-2)'
    }
  }, "Hire history"), worker.hires.map((h, i) => /*#__PURE__*/React.createElement("div", {
    key: h.id || i,
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      marginBottom: 3,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: `ws-status ${h.status === 'ACTIVE' ? 'hired' : 'available'}`,
    style: {
      fontSize: 10
    }
  }, h.status), h.contractType && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-3)'
    }
  }, h.contractType), h.rate && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 500
    }
  }, h.currency || '', " ", h.rate, "/", h.rateType || 'day'), h.startDate && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-3)'
    }
  }, h.startDate, h.endDate ? ` — ${h.endDate}` : ' — present'), h.tenure > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-3)'
    }
  }, "(", h.tenure, "d)")))), /*#__PURE__*/React.createElement("div", {
    className: "ws-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm ${selected ? 'btn-primary' : ''}`,
    onClick: () => onToggleSelect && onToggleSelect(worker),
    style: selected ? {} : {
      border: '1px solid var(--accent)',
      color: 'var(--accent)'
    }
  }, selected ? '✓ Selected' : 'Select'), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: () => setExpanded(!expanded),
    style: {
      marginLeft: 'auto'
    }
  }, expanded ? 'Less' : 'Score details')));
}
function WorksomeTalentPanel({
  workers,
  onHire,
  onClose,
  routeResult
}) {
  const panelRef = React.useRef(null);
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  const [inviteLoading, setInviteLoading] = React.useState(false);
  const [inviteResult, setInviteResult] = React.useState(null);
  React.useEffect(() => {
    if (panelRef.current) {
      panelRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }, []);
  if (!workers || workers.length === 0) return null;
  const topScore = workers[0]?.fitScore || 0;
  const hasStrongMatch = topScore >= 40;
  const hasDecentMatch = topScore >= 25;
  const toggleSelect = worker => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(worker.id)) {
        next.delete(worker.id);
      } else {
        next.add(worker.id);
      }
      return next;
    });
  };
  const selectAll = () => {
    if (selectedIds.size === workers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(workers.map(w => w.id)));
    }
  };
  const handleCreateJobAndInvite = async () => {
    if (selectedIds.size === 0) return;
    setInviteLoading(true);
    try {
      const selectedWorkers = workers.filter(w => selectedIds.has(w.id));
      // Pull skills from route result, or extract from selected workers' skills
      const fallbackSkills = [...new Set(selectedWorkers.flatMap(w => w.skills || []))].slice(0, 5);
      const jobDetails = {
        role_title: routeResult?.role_title || 'New Role',
        description: routeResult?.description || '',
        skills: routeResult?.skills && routeResult.skills.length > 0 ? routeResult.skills : fallbackSkills,
        duration: routeResult?.duration || '',
        location: routeResult?.location || 'remote',
        payment_model: routeResult?.payment_model || 'unknown',
        headcount: selectedWorkers.length
      };
      const res = await fetch('/api/worksome/invite', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          jobDetails,
          workerIds: Array.from(selectedIds),
          workerNames: Object.fromEntries(selectedWorkers.map(w => [w.id, w.name]))
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create job');
      setInviteResult(data);
      console.log('[Front Door] Job created and workers invited:', data);
    } catch (err) {
      console.error('[Front Door] Invite error:', err);
      setInviteResult({
        error: err.message
      });
    }
    setInviteLoading(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "ws-panel",
    ref: panelRef
  }, /*#__PURE__*/React.createElement("div", {
    className: "ws-header"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, "Talent Pool Matches"), /*#__PURE__*/React.createElement("span", {
    className: "ws-badge"
  }, workers.length, " found")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: selectAll,
    style: {
      fontSize: 11
    }
  }, selectedIds.size === workers.length ? 'Deselect all' : 'Select all'), onClose && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    onClick: onClose,
    style: {
      padding: '2px 6px'
    }
  }, "\xD7"))), !hasStrongMatch && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px',
      fontSize: 11,
      color: 'var(--text-3)',
      background: 'var(--bg)',
      borderBottom: '1px solid var(--border-light)',
      lineHeight: 1.4
    }
  }, !hasDecentMatch ? "No close skill matches in your talent pool — showing the closest profiles available. Consider posting the role to attract new candidates." : "These are the closest matches from your talent pool. Scores reflect skill alignment with your requirements."), workers.map(w => /*#__PURE__*/React.createElement(WorksomeTalentCard, {
    key: w.id,
    worker: w,
    onHire: onHire,
    selected: selectedIds.has(w.id),
    onToggleSelect: toggleSelect
  })), selectedIds.size > 0 && !inviteResult && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px',
      background: 'var(--accent-bg)',
      borderTop: '2px solid var(--accent)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 500,
      color: 'var(--accent)'
    }
  }, selectedIds.size, " worker", selectedIds.size !== 1 ? 's' : '', " selected"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    onClick: handleCreateJobAndInvite,
    disabled: inviteLoading,
    style: {
      minWidth: 160
    }
  }, inviteLoading ? 'Creating job...' : `Create Job & Invite ${selectedIds.size}`)), inviteResult && !inviteResult.error && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px',
      background: '#f0fdf4',
      borderTop: '2px solid #22c55e'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: '#15803d',
      marginBottom: 6
    }
  }, "\u2713 Job created in Worksome"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#166534',
      marginBottom: 8
    }
  }, inviteResult.job_title, " \u2014 ", inviteResult.results?.length || 0, " worker", (inviteResult.results?.length || 0) !== 1 ? 's' : '', " selected"), inviteResult.results && inviteResult.results.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.workerId,
    style: {
      fontSize: 12,
      marginBottom: 3,
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      flexShrink: 0,
      background: '#22c55e'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 500
    }
  }, r.workerName || r.workerId))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      display: 'flex',
      gap: 8
    }
  }, inviteResult.job_url && /*#__PURE__*/React.createElement("a", {
    href: inviteResult.job_url,
    target: "_blank",
    rel: "noopener",
    className: "btn btn-sm btn-primary",
    style: {
      textDecoration: 'none',
      display: 'inline-flex'
    }
  }, "Open in Worksome \u2192"))), inviteResult && inviteResult.error && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px',
      background: 'var(--red-bg)',
      borderTop: '2px solid var(--red)',
      fontSize: 12,
      color: 'var(--red)'
    }
  }, "Error: ", inviteResult.error, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => setInviteResult(null),
    style: {
      marginLeft: 8
    }
  }, "Retry")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px',
      borderTop: '1px solid var(--border-light)',
      fontSize: 10,
      color: 'var(--text-3)',
      lineHeight: 1.4
    }
  }, "Scored from your Worksome talent pool. Fit scores are based on skills, title, engagement history, availability, and profile completeness."));
}

// ══════════════════════════════════════
// BEELINE REQUISITION PREVIEW
// ══════════════════════════════════════
function BeelinePreview({
  routeResult,
  vmsName,
  approvalGate
}) {
  const [req, setReq] = React.useState(null);
  const [showJson, setShowJson] = React.useState(false);
  React.useEffect(() => {
    fetch('/api/beeline/preview', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        ...routeResult,
        _approvalRequired: !!(approvalGate && !approvalGate.approved)
      })
    }).then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.requisition) setReq(d.requisition);
    }).catch(() => {});
  }, []);
  if (!req) return null;
  const rows = [['Type', req.requisitionType === 'SOW' ? 'Statement of Work' : 'Staff Augmentation'], ['Positions', req.numberOfPositions], ['Duration', req.estimatedDuration || '—'], ['Dates', req.endDate ? `${req.startDate} → ${req.endDate}` : req.startDate || '—'], ['Rate type', req.rateType ? req.rateType.toLowerCase() : '—'], ['Remote allowed', req.location && req.location.remoteAllowed ? 'Yes' : 'No'], ['Approval', req.approvalStatus.replace(/_/g, ' ').toLowerCase()]];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '10px 12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      color: 'var(--text-3)'
    }
  }, vmsName, " requisition preview"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost btn-sm",
    style: {
      fontSize: 11,
      padding: '2px 6px'
    },
    onClick: () => setShowJson(!showJson)
  }, showJson ? 'Summary' : 'JSON')), showJson ? /*#__PURE__*/React.createElement("pre", {
    style: {
      fontSize: 10.5,
      fontFamily: 'var(--mono)',
      whiteSpace: 'pre-wrap',
      maxHeight: 220,
      overflowY: 'auto',
      margin: 0,
      color: 'var(--text-2)'
    }
  }, JSON.stringify(req, null, 2)) : /*#__PURE__*/React.createElement("div", null, rows.map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      fontSize: 12,
      padding: '2px 0'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 110,
      color: 'var(--text-3)',
      flexShrink: 0
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text)'
    }
  }, v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: 'var(--text-3)',
      marginTop: 6
    }
  }, "This requisition is created automatically in ", vmsName, " once the API connection is enabled."));
}

// ══════════════════════════════════════
// CONFIG PAGE
// ══════════════════════════════════════
function ConfigPage({
  config,
  updateConfig,
  saveConfig,
  configDirty,
  configStatus
}) {
  const updateBranding = (k, v) => updateConfig({
    branding: {
      ...config.branding,
      [k]: v
    }
  });
  const updateVms = (k, v) => updateConfig({
    vms: {
      ...config.vms,
      [k]: v
    }
  });
  const updateWeights = (k, v) => updateConfig({
    weights: {
      ...config.weights,
      [k]: parseInt(v) || 0
    }
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "config-wrap",
    style: {
      height: '100%',
      overflowY: 'auto',
      padding: '24px 32px',
      maxWidth: 720
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 18,
      fontWeight: 700
    }
  }, "Settings"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center'
    }
  }, configStatus === 'saved' && !configDirty && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--accent)'
    }
  }, "\u2713 Saved"), configStatus === 'error' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--red)'
    }
  }, "Save failed \u2014 try again"), configDirty && configStatus !== 'saving' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)'
    }
  }, "Unsaved changes"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: () => saveConfig(config),
    disabled: !configDirty || configStatus === 'saving'
  }, configStatus === 'saving' ? 'Saving...' : 'Save settings'))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      marginBottom: 16,
      marginTop: -10
    }
  }, "Settings are saved on the server and drive the live routing prompt \u2014 knockouts and weights take effect on the next message."), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "AI Chat API"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--accent)',
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--accent)',
      display: 'inline-block'
    }
  }), "Connected \u2014 API key managed by server")), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "Branding"), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Client Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.client_name,
    onChange: e => updateConfig({
      client_name: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Assistant Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.assistant_name,
    onChange: e => updateConfig({
      assistant_name: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Logo Text"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.logo_text,
    maxLength: 3,
    style: {
      width: 80
    },
    onChange: e => updateBranding('logo_text', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Primary Colour"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: config.branding.primary_color,
    style: {
      width: 36,
      height: 30,
      border: '1px solid var(--border)',
      borderRadius: 4,
      cursor: 'pointer',
      padding: 2
    },
    onChange: e => updateBranding('primary_color', e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.primary_color,
    style: {
      width: 100,
      fontFamily: 'var(--mono)',
      fontSize: 12
    },
    onChange: e => updateBranding('primary_color', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-row",
    style: {
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label",
    style: {
      marginTop: 8
    }
  }, "Greeting"), /*#__PURE__*/React.createElement("textarea", {
    className: "input",
    value: config.branding.greeting,
    rows: 2,
    onChange: e => updateBranding('greeting', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "Left Panel"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      marginBottom: 14
    }
  }, "Customise the welcome panel. Add a logo image and hero image, or leave blank to show live stats cards."), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Logo Image URL"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.logo_url || '',
    placeholder: "https://... (replaces logo text)",
    onChange: e => updateBranding('logo_url', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Hero Image URL"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.hero_image_url || '',
    placeholder: "https://... (replaces stats cards)",
    onChange: e => updateBranding('hero_image_url', e.target.value)
  })), (config.branding.hero_image_url || config.branding.logo_url) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      marginTop: 8,
      flexWrap: 'wrap'
    }
  }, config.branding.logo_url && /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)',
      marginBottom: 4
    }
  }, "Logo preview"), /*#__PURE__*/React.createElement("img", {
    src: config.branding.logo_url,
    alt: "Logo",
    style: {
      height: 32,
      objectFit: 'contain'
    },
    onError: e => e.target.style.display = 'none'
  })), config.branding.hero_image_url && /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)',
      marginBottom: 4
    }
  }, "Hero preview"), /*#__PURE__*/React.createElement("img", {
    src: config.branding.hero_image_url,
    alt: "Hero",
    style: {
      height: 80,
      objectFit: 'contain',
      borderRadius: 4
    },
    onError: e => e.target.style.display = 'none'
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-row",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Headline"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.headline || '',
    placeholder: `Default: Welcome to ${config.assistant_name}`,
    onChange: e => updateBranding('headline', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Subheadline"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.branding.subheadline || '',
    placeholder: "Default: Tell us what you need...",
    onChange: e => updateBranding('subheadline', e.target.value)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "VMS Provider"), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "VMS Name"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.vms.name,
    placeholder: "e.g. Beeline, Fieldglass, Coupa",
    onChange: e => updateVms('name', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "VMS URL"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.vms.url,
    onChange: e => updateVms('url', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, "Worksome URL"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: config.worksome_url,
    onChange: e => updateConfig({
      worksome_url: e.target.value
    })
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "Signal Weights"), Object.entries(config.weights).map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    className: "config-row",
    key: k
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label"
  }, k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "number",
    min: "0",
    max: "5",
    value: v,
    style: {
      width: 70
    },
    onChange: e => updateWeights(k, e.target.value)
  })))), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "Knockout Signals"), /*#__PURE__*/React.createElement("div", {
    className: "config-row",
    style: {
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label",
    style: {
      marginTop: 8
    }
  }, "\u2192 VMS"), /*#__PURE__*/React.createElement("textarea", {
    className: "input",
    rows: 2,
    value: config.knockouts.vms.join(', '),
    onChange: e => updateConfig({
      knockouts: {
        ...config.knockouts,
        vms: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
      }
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "config-row",
    style: {
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-label",
    style: {
      marginTop: 8
    }
  }, "\u2192 Worksome"), /*#__PURE__*/React.createElement("textarea", {
    className: "input",
    rows: 2,
    value: config.knockouts.worksome.join(', '),
    onChange: e => updateConfig({
      knockouts: {
        ...config.knockouts,
        worksome: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
      }
    })
  }))), /*#__PURE__*/React.createElement("div", {
    className: "config-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "config-section-title"
  }, "Approval Gates"), config.approval_gates.map((g, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      whiteSpace: 'nowrap'
    }
  }, "If"), /*#__PURE__*/React.createElement("input", {
    className: "input input-sm",
    value: g.condition,
    onChange: e => {
      const gates = [...config.approval_gates];
      gates[i] = {
        ...g,
        condition: e.target.value
      };
      updateConfig({
        approval_gates: gates
      });
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      whiteSpace: 'nowrap'
    }
  }, "\u2192"), /*#__PURE__*/React.createElement("input", {
    className: "input input-sm",
    value: g.action,
    onChange: e => {
      const gates = [...config.approval_gates];
      gates[i] = {
        ...g,
        action: e.target.value
      };
      updateConfig({
        approval_gates: gates
      });
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-danger",
    onClick: () => {
      const gates = config.approval_gates.filter((_, j) => j !== i);
      updateConfig({
        approval_gates: gates
      });
    }
  }, "\xD7"))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => updateConfig({
      approval_gates: [...config.approval_gates, {
        condition: '',
        action: ''
      }]
    })
  }, "+ Add gate")));
}

// ══════════════════════════════════════
// SVG CHART HELPERS
// ══════════════════════════════════════
function SvgBarChart({
  data,
  barKeys,
  colors,
  labels,
  height = 220
}) {
  const maxVal = Math.max(1, ...data.flatMap(d => barKeys.map(k => d[k])));
  const w = 500,
    h = height - 40,
    pad = {
      top: 10,
      right: 20,
      bottom: 30,
      left: 35
    };
  const plotW = w - pad.left - pad.right,
    plotH = h - pad.top - pad.bottom;
  const groupW = plotW / data.length;
  const barW = Math.min(groupW * 0.35, 28);
  const yTicks = [0, Math.round(maxVal / 2), maxVal];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    style: {
      width: '100%',
      height: height - 20
    }
  }, yTicks.map(t => {
    const y = pad.top + plotH - t / maxVal * plotH;
    return /*#__PURE__*/React.createElement("g", {
      key: t
    }, /*#__PURE__*/React.createElement("line", {
      x1: pad.left,
      y1: y,
      x2: w - pad.right,
      y2: y,
      stroke: "#e2e5ea",
      strokeDasharray: "3 3"
    }), /*#__PURE__*/React.createElement("text", {
      x: pad.left - 6,
      y: y + 4,
      textAnchor: "end",
      fontSize: "11",
      fill: "#9ba3b0"
    }, t));
  }), data.map((d, i) => {
    const cx = pad.left + groupW * i + groupW / 2;
    return /*#__PURE__*/React.createElement("g", {
      key: i
    }, /*#__PURE__*/React.createElement("text", {
      x: cx,
      y: h - 6,
      textAnchor: "middle",
      fontSize: "11",
      fill: "#9ba3b0"
    }, d.week), barKeys.map((k, ki) => {
      const bh = d[k] / maxVal * plotH;
      const bx = cx - barKeys.length * barW / 2 + ki * (barW + 2);
      return /*#__PURE__*/React.createElement("rect", {
        key: k,
        x: bx,
        y: pad.top + plotH - bh,
        width: barW,
        height: bh,
        rx: "3",
        fill: colors[ki]
      });
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      justifyContent: 'center'
    }
  }, barKeys.map((k, i) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 11,
      color: '#5f6776'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: colors[i]
    }
  }), labels[i]))));
}
function SvgDonut({
  slices,
  size = 160
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = 55,
    ir = 35,
    cx = size / 2,
    cy = size / 2;
  let cum = 0;
  const paths = slices.map((s, i) => {
    const frac = s.value / total;
    const startAngle = cum * 2 * Math.PI - Math.PI / 2;
    cum += frac;
    const endAngle = cum * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle),
      y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle),
      y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + ir * Math.cos(endAngle),
      iy1 = cy + ir * Math.sin(endAngle);
    const ix2 = cx + ir * Math.cos(startAngle),
      iy2 = cy + ir * Math.sin(startAngle);
    const d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2} Z`;
    return /*#__PURE__*/React.createElement("path", {
      key: i,
      d: d,
      fill: s.color
    });
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`
  }, paths), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      justifyContent: 'center',
      marginTop: 8
    }
  }, slices.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 11,
      color: '#5f6776'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: s.color
    }
  }), s.label, " (", s.value, ")"))));
}
function SvgLineChart({
  data,
  dataKey,
  height = 180
}) {
  const vals = data.map(d => d[dataKey]);
  const maxVal = Math.max(...vals),
    minVal = Math.min(...vals);
  const range = maxVal - minVal || 1;
  const w = 500,
    h = height - 30,
    pad = {
      top: 10,
      right: 20,
      bottom: 30,
      left: 35
    };
  const plotW = w - pad.left - pad.right,
    plotH = h - pad.top - pad.bottom;
  const points = data.map((d, i) => ({
    x: pad.left + i / (data.length - 1) * plotW,
    y: pad.top + plotH - (d[dataKey] - minVal) / range * plotH
  }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const yTicks = [minVal, Math.round((minVal + maxVal) / 2), maxVal];
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    style: {
      width: '100%',
      height: height
    }
  }, yTicks.map(t => {
    const y = pad.top + plotH - (t - minVal) / range * plotH;
    return /*#__PURE__*/React.createElement("g", {
      key: t
    }, /*#__PURE__*/React.createElement("line", {
      x1: pad.left,
      y1: y,
      x2: w - pad.right,
      y2: y,
      stroke: "#e2e5ea",
      strokeDasharray: "3 3"
    }), /*#__PURE__*/React.createElement("text", {
      x: pad.left - 6,
      y: y + 4,
      textAnchor: "end",
      fontSize: "11",
      fill: "#9ba3b0"
    }, t));
  }), data.map((d, i) => /*#__PURE__*/React.createElement("text", {
    key: i,
    x: points[i].x,
    y: h - 4,
    textAnchor: "middle",
    fontSize: "11",
    fill: "#9ba3b0"
  }, d.week)), /*#__PURE__*/React.createElement("path", {
    d: linePath,
    fill: "none",
    stroke: "#6b3fa0",
    strokeWidth: "2"
  }), points.map((p, i) => /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: p.x,
    cy: p.y,
    r: "4",
    fill: "#6b3fa0"
  })));
}

// ══════════════════════════════════════
// ANALYTICS PAGE
// ══════════════════════════════════════
function AnalyticsPage({
  config
}) {
  const stats = useAnalytics();
  if (!stats) {
    return /*#__PURE__*/React.createElement("div", {
      className: "analytics-wrap",
      style: {
        height: '100%',
        overflowY: 'auto',
        padding: '24px 32px'
      }
    }, /*#__PURE__*/React.createElement("h2", {
      style: {
        fontSize: 18,
        fontWeight: 700,
        marginBottom: 20
      }
    }, "Analytics"), /*#__PURE__*/React.createElement("div", {
      style: {
        color: 'var(--text-3)',
        fontSize: 13
      }
    }, "Loading\u2026"));
  }
  const hasData = stats.total > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "analytics-wrap",
    style: {
      height: '100%',
      overflowY: 'auto',
      padding: '24px 32px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 18,
      fontWeight: 700,
      marginBottom: 6
    }
  }, "Analytics"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-3)',
      marginBottom: 20
    }
  }, "Live data from completed intakes \u2014 web portal and Slack."), /*#__PURE__*/React.createElement("div", {
    className: "stats-grid-4",
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 16,
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, stats.total), /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, "Total requests")), /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-value",
    style: {
      color: 'var(--accent)'
    }
  }, stats.worksome), /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, "\u2192 Worksome")), /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-value",
    style: {
      color: 'var(--warn)'
    }
  }, stats.vms), /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, "\u2192 ", config.vms.name)), /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, stats.avgDurationSeconds ? stats.avgDurationSeconds + 's' : '—'), /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, "Avg. intake time"))), !hasData && /*#__PURE__*/React.createElement("div", {
    className: "stat-card",
    style: {
      marginBottom: 24,
      textAlign: 'center',
      padding: 48,
      color: 'var(--text-3)',
      fontSize: 13
    }
  }, "No intake data yet. Complete a hiring request in the chat (or via Slack) and it will appear here."), hasData && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "charts-grid",
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1fr',
      gap: 16,
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 16
    }
  }, "Weekly volume by route"), /*#__PURE__*/React.createElement(SvgBarChart, {
    data: stats.weeklyVolume,
    barKeys: ['worksome', 'vms'],
    colors: ['#6b3fa0', '#b45309'],
    labels: ['Worksome', config.vms.name]
  })), /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 16
    }
  }, "Routing split"), /*#__PURE__*/React.createElement(SvgDonut, {
    slices: [{
      value: stats.worksome,
      color: '#6b3fa0',
      label: 'Worksome'
    }, {
      value: stats.vms,
      color: '#b45309',
      label: config.vms.name
    }]
  }))), /*#__PURE__*/React.createElement("div", {
    className: "stat-card",
    style: {
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 16
    }
  }, "Avg. intake duration by week (seconds)"), /*#__PURE__*/React.createElement(SvgLineChart, {
    data: stats.avgDurationWeekly,
    dataKey: "seconds"
  }))), hasData && /*#__PURE__*/React.createElement("div", {
    className: "stat-card"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 16
    }
  }, "Recent requests"), /*#__PURE__*/React.createElement("div", {
    className: "table-wrap"
  }, /*#__PURE__*/React.createElement("table", {
    className: "table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Date"), /*#__PURE__*/React.createElement("th", null, "Role"), /*#__PURE__*/React.createElement("th", null, "Source"), /*#__PURE__*/React.createElement("th", null, "Route"), /*#__PURE__*/React.createElement("th", null, "Confidence"), /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "Duration"))), /*#__PURE__*/React.createElement("tbody", null, stats.recent.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id
  }, /*#__PURE__*/React.createElement("td", null, r.date), /*#__PURE__*/React.createElement("td", {
    style: {
      fontWeight: 500
    }
  }, r.role), /*#__PURE__*/React.createElement("td", null, r.channel === 'slack' ? 'Slack' : 'Web'), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: `badge ${r.route === 'worksome' ? 'badge-green' : 'badge-orange'}`
  }, r.route === 'worksome' ? 'Worksome' : config.vms.name)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: `badge ${r.confidence === 'high' ? 'badge-blue' : 'badge-gray'}`
  }, r.confidence)), /*#__PURE__*/React.createElement("td", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, r.status.replace(/_/g, ' ')), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: 'var(--mono)',
      fontSize: 12
    }
  }, r.durationSeconds ? r.durationSeconds + 's' : '—'))))))));
}

// ══════════════════════════════════════
// RENDER
// ══════════════════════════════════════
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));