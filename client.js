/**
 * Browser half of the Open Design bridge: the model / provider / reasoning
 * controls on this bundle's Plugin Manager page.
 *
 * Scope note that drives the whole view: these controls set what THIS side sends
 * when `opendesign_ask` starts a turn. They are not a mirror of Open Design's own
 * model picker, and they never write Open Design's configuration. The values are
 * seeded once from Open Design at first run, then belong to this side.
 *
 * Layout follows the host settings idiom (label column + control column, rows)
 * rather than inventing a shape, and every failure state is shown rather than
 * smoothed over: a stale stored value is reported, not silently replaced by the
 * first option in the list.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-opendesign-member',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Namespace shared with the Host route and the locale dictionaries. */
    const NS = 'opendesign-member';

    /** This bundle's package name: the key the Plugin Manager page dispatches by. */
    const PACKAGE_NAME = '@local/dsh-opendesign-member';

    /** Host route serving this bundle's settings. `dsh-host-webserver` adds no auth. */
    const ENDPOINT = '/api/opendesign-member/settings';

    /**
     * Call the Host route and unwrap its typed envelope.
     *
     * The route rides the authenticated `/api` channel, so the browser's own
     * same-origin credentials travel with the request; this code adds no token.
     * A failure is always returned as a reason string, never swallowed: the whole
     * point of the panel is that a broken read looks broken.
     *
     * @param method - `GET` to read, `POST` to write.
     * @param patch - body for a write.
     * @param force - ask the Host to re-probe the daemon instead of its cache.
     */
    async function callRoute(method, patch, force) {
      const url = force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT;
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: patch === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
          credentials: 'same-origin',
          ...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
        });
      } catch (error) {
        return { ok: false, error: `cannot reach the Harness Host: ${error instanceof Error ? error.message : String(error)}` };
      }
      const payload = await response.json().catch(() => undefined);
      if (payload === undefined || typeof payload !== 'object') {
        return { ok: false, error: `the Harness Host answered HTTP ${response.status} with a body that is not JSON` };
      }
      if (payload.ok !== true) {
        const code = payload.error?.code;
        const message = payload.error?.message;
        const reason = typeof message === 'string' && message.length > 0
          ? message
          : `the Harness Host rejected the call (HTTP ${response.status}${typeof code === 'string' ? `, ${code}` : ''})`;
        return { ok: false, error: reason };
      }
      return { ok: true, value: payload.value };
    }

    /** Read the Host settings snapshot; `force` re-probes the daemon. */
    async function readSettings(force) {
      return await callRoute('GET', undefined, force === true);
    }

    /** Submit one change; resolves to the updated snapshot or a reason. */
    async function writeSettings(patch) {
      return await callRoute('POST', patch);
    }

    /** Section chrome: heading, one-line description, then the rows. */
    const sectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '20px 0 4px',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24))',
    };

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '16px', minHeight: '32px' };

    const labelStyle = {
      flex: '0 0 128px',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      fontSize: '13px',
      lineHeight: '20px',
    };

    /** Controls align on one left edge and stop short of the section width. */
    const controlStyle = {
      flex: '1 1 auto',
      maxWidth: '360px',
      minWidth: '180px',
      height: '30px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.32))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: '13px',
    };

    /** The band that carries anything that changes the block's trustworthiness. */
    function StatusBand({ tone, text, action }) {
      if (text === undefined || text.length === 0) return null;
      const palette = tone === 'error'
        ? { border: 'var(--dsw-alias-state-error-primary, #d9534f)', color: 'var(--dsw-alias-state-error-primary, #d9534f)' }
        : tone === 'warn'
          ? { border: 'var(--dsw-alias-state-warn-primary, #d9a441)', color: 'var(--dsw-alias-state-warn-primary, #d9a441)' }
          : { border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.32))', color: 'var(--dsw-alias-label-secondary, inherit)' };
      return h('div', {
        role: tone === 'error' ? 'alert' : 'status',
        'aria-live': 'polite',
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          padding: '8px 10px',
          borderRadius: '6px',
          border: `1px solid ${palette.border}`,
          color: palette.color,
          fontSize: '12.5px',
          lineHeight: '18px',
        },
      }, [
        h('span', { key: 'text', style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } }, text),
        action === undefined ? null : h('button', {
          key: 'action',
          type: 'button',
          onClick: action.run,
          style: {
            flex: '0 0 auto',
            padding: '0 8px',
            height: '22px',
            borderRadius: '5px',
            border: `1px solid ${palette.border}`,
            background: 'transparent',
            color: palette.color,
            fontSize: '12px',
            cursor: 'pointer',
          },
        }, action.label),
      ]);
    }

    /** One label + control row. */
    function Row({ label, children }) {
      return h('div', { style: rowStyle }, [
        h('div', { key: 'label', style: labelStyle }, label),
        h('div', { key: 'control', style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '8px' } }, children),
      ]);
    }

    /**
     * A `<select>` styled like the host's own controls.
     *
     * The current value is ALWAYS present among the options. A `<select>` whose
     * `value` matches no option silently renders as the first option, which would
     * show a model the user did not choose — exactly the kind of quiet lie this
     * panel exists to avoid. When the stored value is not offered (the provider
     * changed, a model was withdrawn), it is kept visible and flagged instead.
     */
    function Select({ value, options, disabled, onChange, placeholder, staleLabel }) {
      const hasValue = options.some((option) => option.value === value);
      const needsStale = !hasValue && value !== '' && value !== undefined;
      const all = needsStale
        ? [{ value, label: staleLabel === undefined ? `${value} (unavailable)` : staleLabel, disabled: true }, ...options]
        : options;
      return h('select', {
        // An empty string keeps React in controlled mode; when nothing matches we
        // show the placeholder rather than a random first entry.
        value: hasValue ? value : (needsStale ? value : ''),
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
        title: needsStale ? (staleLabel ?? String(value)) : undefined,
        style: { ...controlStyle, ...(disabled === true ? { opacity: 0.6, cursor: 'not-allowed' } : { cursor: 'pointer' }) },
      }, [
        placeholder === undefined ? null : h('option', { key: '__none', value: '' }, placeholder),
        ...all.map((option) => h('option', {
          key: option.value,
          value: option.value,
          disabled: option.disabled === true,
        }, option.label)),
      ]);
    }

    /**
     * Group the flat catalogue into providers, preserving the Host's order.
     *
     * Provider is a real dimension rather than an id prefix: the same model id
     * accepts different reasoning tiers per provider, so the two must not be
     * collapsed into one list.
     */
    function groupByProvider(catalogue) {
      const groups = new Map();
      for (const entry of catalogue ?? []) {
        const key = entry.provider ?? '';
        if (!groups.has(key)) groups.set(key, { provider: key, label: entry.providerLabel ?? key, models: [] });
        groups.get(key).models.push(entry);
      }
      return [...groups.values()];
    }

    /**
     * The panel. Renders nothing outside this bundle's own page.
     *
     * The guard sits in this hook-free wrapper on purpose: returning early from a
     * component that already ran `useState` would change hook order between
     * renders and make React throw. Mounting (or not) the body component instead
     * keeps every hook inside a component that only ever exists on one page.
     */
    function ModelSettingsSection(props) {
      // The detail page dispatches this slot for every page it opens. Only the
      // page of THIS bundle owns these controls, so every other subject — another
      // package, a row's configuration page, an official plugin — renders nothing.
      //
      // Verified against the shipped page: a bundle page passes
      // `{ kind: 'bundle', pkg: { name, version, ... } }`, a row's configuration
      // page passes `{ kind: 'row', pkg, row }`, and an official plugin passes
      // `{ kind: 'package', ... }`. The package name therefore lives at
      // `subject.pkg.name`, not on the subject itself.
      if (props.subject?.pkg?.name !== PACKAGE_NAME) return null;
      return h(ModelSettingsPanel, props);
    }

    /**
     * The panel body. Holds every hook, so it is only ever mounted on this
     * bundle's own page — the guard lives in the wrapper above it.
     */
    function ModelSettingsPanel(props) {
      const t = props.t ?? ((key) => key);
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [failure, setFailure] = React.useState(undefined);
      const [pending, setPending] = React.useState(false);
      const [refreshing, setRefreshing] = React.useState(false);
      const [panelFailure, setPanelFailure] = React.useState(undefined);

      const load = React.useCallback(async (force) => {
        if (force === true) setRefreshing(true);
        const result = await readSettings(force === true);
        if (force === true) setRefreshing(false);
        if (result.ok) {
          setSnapshot(result.value);
          setFailure(undefined);
        } else {
          setSnapshot(undefined);
          setFailure(result.error);
        }
      }, []);

      React.useEffect(() => { void load(false); }, [load]);

      /** Apply one change, rolling the control back and naming the reason on failure. */
      const commit = React.useCallback(async (patch) => {
        if (pending) return;
        setPending(true);
        const result = await writeSettings(patch);
        setPending(false);
        if (result.ok) {
          // The write returns the fresh snapshot, so no second round-trip and no
          // ten-second catalogue re-probe: the controls settle immediately.
          setSnapshot(result.value);
          setFailure(undefined);
          return;
        }
        // Never leave an optimistic value on screen. Re-read WITHOUT forcing, so
        // the rollback is instant; the reason stays visible in the band.
        setFailure(result.error);
        await load(false);
      }, [pending, load]);

      const heading = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
        h('div', { key: 'title', style: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' } },
          t('section.title')),
        h('div', { key: 'desc', style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: '18px' } },
          t('section.description')),
      ]);

      // Loading and hard failure are distinct: a failure keeps the controls
      // disabled with an unknown marker rather than pretending a value is known.
      if (snapshot === undefined) {
        return h('div', { style: sectionStyle }, [
          h('div', { key: 'head' }, heading),
          h(StatusBand, {
            key: 'band',
            tone: 'error',
            text: failure === undefined
              ? t('state.loading')
              : `${t('state.unreachable')}\n${failure}`,
            action: failure === undefined ? undefined : { label: t('action.retry'), run: () => { void load(); } },
          }),
          h(Row, { key: 'provider', label: t('row.provider') }, h(Select, {
            value: '', options: [], disabled: true, onChange: () => {}, placeholder: t('state.unknown'),
          })),
          h(Row, { key: 'model', label: t('row.model') }, h(Select, {
            value: '', options: [], disabled: true, onChange: () => {}, placeholder: t('state.unknown'),
          })),
          h(Row, { key: 'reasoning', label: t('row.reasoning') }, h(Select, {
            value: '', options: [], disabled: true, onChange: () => {}, placeholder: t('state.unknown'),
          })),
        ]);
      }

      const selection = snapshot.selection ?? {};
      const groups = groupByProvider(snapshot.catalogue);
      const currentProvider = selection.provider ?? '';
      const providerOptions = groups.map((group) => ({ value: group.provider, label: group.label }));
      const providerModels = groups.find((group) => group.provider === currentProvider)?.models ?? [];
      const modelOptions = providerModels.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }));
      const reasoningOptions = (selection.reasoningOptions ?? []).map((option) => ({ value: option.id, label: option.label ?? option.id }));
      const reasoningDisabled = reasoningOptions.length === 0;

      // Two different truths, reported separately: a settings write that failed
      // just now, and stored values that no longer exist in the catalogue.
      const problems = Array.isArray(selection.problems) ? selection.problems : [];
      const band = failure !== undefined
        ? { tone: 'error', text: `${t('state.writeFailed')}\n${failure}`, action: { label: t('action.retry'), run: () => { void load(true); } } }
        : problems.length > 0
          ? { tone: 'warn', text: `${t('state.stale')}\n${problems.join('\n')}`, action: undefined }
          : snapshot.seededNow === true
            ? { tone: 'info', text: t('state.seeded'), action: undefined }
            : undefined;

      const seededNote = snapshot.settings?.seededFrom === undefined || snapshot.settings?.seededFrom === null
        ? undefined
        : t('state.seededFrom');

      return h('div', { style: sectionStyle }, [
        h('div', { key: 'head' }, [
          heading,
          h('div', { key: 'refresh', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' } }, [
            // Which CLI Open Design currently has selected. Shown because these
            // controls change the model for THAT CLI: seeing the name is what
            // makes a wrong assumption obvious.
            h('span', { key: 'cli', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' } },
              snapshot.agentName === undefined || snapshot.agentName === null
                ? t('state.cliUnknown')
                : t('state.cli').replace('{name}', String(snapshot.agentName))),
            h('button', {
              key: 'btn',
              type: 'button',
              disabled: refreshing || pending,
              onClick: () => { void load(true); },
              style: {
                padding: '0 8px',
                height: '22px',
                borderRadius: '5px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.32))',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary, inherit)',
                fontSize: '12px',
                cursor: refreshing || pending ? 'not-allowed' : 'pointer',
                opacity: refreshing || pending ? 0.6 : 1,
              },
            }, refreshing ? t('action.refreshing') : t('action.refresh')),
            h('span', { key: 'hint', style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary, inherit)' } },
              t('state.cached')),
          ]),
        ]),
        // Opens the right-bar tab this bundle registers. Kept here because this
        // page is where a human configures the bridge; the tab itself is opened
        // from the right Sidebar's guide once.
        h('div', { key: 'panel', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
          h('button', {
            key: 'open',
            type: 'button',
            disabled: pending,
            onClick: () => {
              setPanelFailure(undefined);
              // The controller throws when no Session is on screen (or the
              // composition has no right Sidebar). Report that instead of doing
              // nothing, which reads as a dead button.
              Promise.resolve(props.openPanel?.()).then((reason) => {
                if (typeof reason === 'string' && reason.length > 0) setPanelFailure(reason);
              }).catch((error) => setPanelFailure(error instanceof Error ? error.message : String(error)));
            },
            style: {
              padding: '0 10px',
              height: '26px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.32))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, inherit)',
              fontSize: '12.5px',
              cursor: 'pointer',
            },
          }, t('action.openPanel')),
          panelFailure === undefined ? null : h('span', {
            key: 'failure',
            role: 'alert',
            style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
          }, panelFailure),
        ]),
        band === undefined ? null : h(StatusBand, { key: 'band', tone: band.tone, text: band.text, action: band.action }),
        // Provider first: it decides which models the next row may offer.
        h(Row, { key: 'provider', label: t('row.provider') }, h(Select, {
          value: currentProvider,
          options: providerOptions,
          disabled: pending,
          placeholder: t('state.unknown'),
          staleLabel: `${currentProvider === '' ? t('row.providerDefault') : currentProvider} (${t('state.unavailable')})`,
          onChange: (provider) => {
            const group = groups.find((entry) => entry.provider === provider);
            const first = group?.models?.[0];
            if (first === undefined) return;
            void commit({ model: first.id });
          },
        })),
        h(Row, { key: 'model', label: t('row.model') }, h(Select, {
          value: selection.model ?? '',
          options: modelOptions,
          disabled: pending,
          placeholder: t('state.unknown'),
          staleLabel: `${selection.model ?? ''} (${t('state.unavailable')})`,
          onChange: (model) => { void commit({ model }); },
        })),
        h(Row, { key: 'reasoning', label: t('row.reasoning') }, [
          h(Select, {
            key: 'select',
            value: reasoningDisabled ? '' : (selection.reasoning ?? ''),
            options: reasoningOptions,
            disabled: pending || reasoningDisabled,
            placeholder: reasoningDisabled ? t('reasoning.none') : t('reasoning.profile'),
            staleLabel: `${selection.reasoning ?? ''} (${t('state.unavailable')})`,
            onChange: (reasoning) => { void commit({ reasoning }); },
          }),
          reasoningDisabled ? null : h('span', {
            key: 'note',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' },
          }, t('reasoning.hint')),
        ]),
        seededNote === undefined ? null : h('div', {
          key: 'seeded',
          style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)', paddingLeft: '144px' },
        }, seededNote),
      ]);
    }

    /**
     * The right Sidebar tab this bundle owns.
     *
     * Open Design's real window is an Electron view on the `od://` scheme, which
     * a browser cannot load. Open Design 0.26.1 also runs a web sidecar that
     * serves the SAME product UI over plain HTTP — that page is what this tab
     * frames, and the Host locates it because its port is ephemeral.
     */
    const TAB_KIND = 'opendesign';
    /** Tab-type identity in the right Sidebar, and the key its body registers under. */
    const TAB_ID = PACKAGE_NAME;
    /** Host route the panel reads its state through (read-only by construction). */
    const PANEL_ENDPOINT = '/api/opendesign-member/panel';

    /**
     * Read the Host's panel snapshot for one Session.
     *
     * Same envelope and same honesty rule as the settings route: a failure is a
     * reason string the panel can show, never a swallowed error that leaves a
     * blank frame behind.
     */
    async function readPanel(sessionId, refresh) {
      const query = new URLSearchParams();
      if (typeof sessionId === 'string' && sessionId.length > 0) query.set('session', sessionId);
      if (refresh === true) query.set('refresh', '1');
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      let response;
      try {
        response = await fetch(`${PANEL_ENDPOINT}${suffix}`, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
      } catch (error) {
        return { ok: false, error: `cannot reach the Harness Host: ${error instanceof Error ? error.message : String(error)}` };
      }
      const payload = await response.json().catch(() => undefined);
      if (payload === undefined || typeof payload !== 'object') {
        return { ok: false, error: `the Harness Host answered HTTP ${response.status} with a body that is not JSON` };
      }
      if (payload.ok !== true) {
        return { ok: false, error: payload.error?.message ?? `the Harness Host rejected the call (HTTP ${response.status})` };
      }
      return { ok: true, value: payload.value };
    }

    /**
     * The one URL a browser can frame: the web sidecar's origin, plus the deep
     * link the Host reports when it knows one.
     *
     * Returns undefined when there is no origin at all; callers must explain the
     * absence instead of framing an empty page.
     */
    function panelSrc(value) {
      const base = String(value?.web?.baseUrl ?? '').replace(/\/+$/, '');
      if (base.length === 0) return undefined;
      const deep = value?.web?.deepLink;
      if (typeof deep === 'string' && deep.length > 0) {
        return `${base}${deep.startsWith('/') ? '' : '/'}${deep}`;
      }
      return `${base}/`;
    }

    const panelRootStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
    };

    const panelBarStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      flex: '0 0 auto',
      flexWrap: 'wrap',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24))',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary, inherit)',
    };

    const panelNoteStyle = {
      padding: '12px',
      fontSize: '12.5px',
      lineHeight: '19px',
      whiteSpace: 'pre-wrap',
      color: 'var(--dsw-alias-label-secondary, inherit)',
    };

    const panelErrorStyle = { ...panelNoteStyle, color: 'var(--dsw-alias-state-error-primary, #d9534f)' };

    const panelButtonStyle = {
      padding: '0 8px',
      height: '22px',
      borderRadius: '5px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.32))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      fontSize: '12px',
      cursor: 'pointer',
    };

    const panelFrameStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      width: '100%',
      border: '0',
      background: '#fff',
    };

    /**
     * A small control in the tab's top strip: reload the iframe, re-probe the
     * Host, or open the product's own window. Buttons rather than text because
     * every one of these is a real user action.
     */
    function PanelButton({ label, onClick, disabled }) {
      return h('button', {
        type: 'button',
        disabled: disabled === true,
        onClick,
        style: { ...panelButtonStyle, opacity: disabled === true ? 0.6 : 1 },
      }, label);
    }

    /**
     * The tab body: frame the Open Design web app when — and only when — the
     * Host proves it is both present and furable.
     *
     * Every state is named on screen. The failure the product must never show is
     * a silently blank iframe: a user would conclude Open Design is broken when
     * in fact a capability is missing or forbidden.
     */
    function PanelBody(props) {
      const t = props.t ?? ((key) => key);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const [state, setState] = React.useState({ phase: 'loading' });
      const [nonce, setNonce] = React.useState(0);
      /**
       * The Host's monotonic "Open Design state changed" counter. A change means
       * the background watcher saw real activity (a turn appeared/settled, a run
       * was collected), which is the signal to reload the embedded frame so the
       * human sees it without clicking anything.
       */
      const revisionRef = React.useRef(undefined);

      const load = React.useCallback(async (refresh) => {
        const result = await readPanel(sessionId, refresh === true);
        if (!result.ok) {
          setState({ phase: 'failed', error: result.error });
          return;
        }
        const value = result.value;
        const previousRevision = revisionRef.current;
        if (previousRevision !== undefined
          && typeof value?.revision === 'number'
          && value.revision !== previousRevision) {
          // Reload the frame (not just the panel): the embedded page is what shows
          // the new run/answer, and it cannot know the Host changed on its own.
          setNonce((current) => current + 1);
        }
        revisionRef.current = value?.revision;
        setState({ phase: 'ready', value });
      }, [sessionId]);

      React.useEffect(() => { void load(false); }, [load]);

      // Two-second re-probe, doing three jobs at once: it keeps the tab honest
      // across an Open Design restart (the sidecar's port moves), it picks up the
      // watcher's revision bumps, and it auto-retries a failed discovery instead
      // of leaving the sidebar dead until the human presses a button.
      React.useEffect(() => {
        const timer = setInterval(() => { void load(false); }, 2_000);
        return () => clearInterval(timer);
      }, [load]);

      if (state.phase === 'loading') {
        return h('div', { style: panelRootStyle }, h('div', { style: panelNoteStyle }, t('panel.loading')));
      }

      if (state.phase === 'failed') {
        return h('div', { style: panelRootStyle }, [
          h('div', { key: 'note', style: panelErrorStyle }, `${t('panel.failed')}\n${state.error}\n\n${t('panel.retrying')}`),
          h('div', { key: 'actions', style: { padding: '0 12px 12px' } },
            h(PanelButton, { label: t('action.retry'), onClick: () => { void load(true); } })),
        ]);
      }

      const value = state.value;
      const src = panelSrc(value);
      const bar = h('div', { style: panelBarStyle }, [
        h('span', { key: 'member', style: { flex: '1 1 auto' } },
          value.member === null || value.member === undefined
            ? t('panel.noMember')
            : t('panel.member').replace('{name}', String(value.member))),
        value.web?.stale === true ? h('span', {
          key: 'stale',
          title: typeof value.web.reason === 'string' ? value.web.reason : undefined,
          style: { color: 'var(--dsw-alias-state-warn-primary, #d9a441)' },
        }, t('panel.stale')) : null,
        src === undefined ? null : h(PanelButton, {
          key: 'reload',
          label: t('panel.reload'),
          onClick: () => {
            setNonce((current) => current + 1);
            void load(true);
          },
        }),
      ]);

      if (src === undefined || value.web?.embeddable !== true) {
        const details = [
          t('panel.notEmbeddable'),
          typeof value.web?.reason === 'string' && value.web.reason.length > 0 ? value.web.reason : undefined,
          value.daemon?.reachable === false ? `${t('panel.daemonDown')}\n${value.daemon.error ?? ''}` : undefined,
          t('panel.bridgeHint'),
        ].filter((line) => typeof line === 'string' && line.length > 0).join('\n\n');
        // A blocked frame is still a working page: open it as a normal tab so the
        // user is never left with only an explanation.
        const externalUrl = src ?? (typeof value.web?.baseUrl === 'string' && value.web.baseUrl.length > 0
          ? `${String(value.web.baseUrl).replace(/\/+$/, '')}/`
          : undefined);
        return h('div', { style: panelRootStyle }, [
          bar,
          h('div', { key: 'note', style: panelNoteStyle, 'aria-live': 'polite' }, details),
          h('div', { key: 'actions', style: { display: 'flex', gap: '8px', padding: '0 12px 12px' } }, [
            h(PanelButton, { key: 'retry', label: t('action.retry'), onClick: () => { void load(true); } }),
            externalUrl === undefined ? null : h(PanelButton, {
              key: 'external',
              label: t('panel.openExternal'),
              onClick: () => { window.open(externalUrl, '_blank', 'noopener'); },
            }),
          ]),
        ]);
      }

      return h('div', { style: panelRootStyle }, [
        bar,
        h('iframe', {
          key: `frame:${src}:${nonce}`,
          src,
          title: t('tab.title'),
          style: panelFrameStyle,
          // A local, first-party product UI: no sandbox attribute, because the
          // app is the same trust domain as the app it belongs to and its own
          // scripts/routes must work exactly as in a normal tab.
          allow: 'clipboard-read; clipboard-write',
        }),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            'section.title': '运行模型',
            'section.description': '决定本插件调用 Open Design 时使用的提供商、模型与推理强度。这些值只作用于 DSH 这一侧发起的调用，不会改动 Open Design 自身的设置。',
            'row.provider': '提供商',
            'row.model': '模型',
            'row.reasoning': '推理强度',
            'state.loading': '正在读取…',
            'state.unreachable': '读不到插件设置，下面的控件不可用。',
            'state.writeFailed': '修改没有生效。',
            'state.unknown': '未知',
            'state.stale': '保存的值已经不在可选范围里，请重新选择：',
            'state.seeded': '已从 Open Design 当前的模型设置读取初值，之后由这里决定。',
            'state.cached': '模型列表长期缓存；只有点「重新读取」才会重新探测。',
            'state.cli': '当前 CLI：{name}',
            'state.cliUnknown': '当前 CLI：未知',
            'state.unavailable': '已不可用',
            'row.providerDefault': 'Open Design 官方',
            'reasoning.none': 'default（该模型没有推理档）',
            'reasoning.profile': 'default（跟随配置）',
            'reasoning.hint': '留空表示不发送推理档，由 profile 决定。',
            'action.retry': '重试',
            'action.refresh': '重新读取',
            'action.refreshing': '读取中…',
            'action.openPanel': '在右栏打开 Open Design',
            'tab.title': 'Open Design',
            'guide.title': 'Open Design 窗口',
            'guide.description': '把 Open Design 的网页版窗口嵌在右栏，和对话并排。',
            'panel.loading': '正在查找 Open Design 窗口…',
            'panel.failed': '读不到面板状态。',
            'panel.retrying': '会自动重试，也可以手动重试。',
            'panel.stale': '地址可能已过期',
            'panel.reload': '重新载入',
            'panel.member': '成员：{name}',
            'panel.noMember': '当前会话不是 Team 成员会话，不知道要显示谁的窗口。',
            'panel.notEmbeddable': '无法把 Open Design 嵌进这里：',
            'panel.openExternal': '在浏览器新标签打开',
            'panel.daemonDown': 'Open Design 的守护进程当前不可达。',
            'panel.bridgeHint': '桥接工具不受影响；Open Design 自己的原生窗口请到桌面应用里查看。',
            'panel.unavailable': '当前界面没有右侧栏，或没有选中会话，无法打开面板。',
          },
          en: {
            'section.title': 'Runtime model',
            'section.description': 'Sets the provider, model, and reasoning tier this plugin uses when it calls Open Design. These values apply only to calls started from this side; they never change Open Design\'s own settings.',
            'row.provider': 'Provider',
            'row.model': 'Model',
            'row.reasoning': 'Reasoning',
            'state.loading': 'Reading…',
            'state.unreachable': 'The plugin settings could not be read, so the controls below are unavailable.',
            'state.writeFailed': 'The change did not apply.',
            'state.unknown': 'unknown',
            'state.stale': 'A saved value is no longer offered. Choose again:',
            'state.seeded': 'Seeded from Open Design\'s current model setting. From now on this side decides.',
            'state.cached': 'The model list is cached long-term; only Refresh re-probes it.',
            'state.cli': 'Current CLI: {name}',
            'state.cliUnknown': 'Current CLI: unknown',
            'state.unavailable': 'unavailable',
            'row.providerDefault': 'Open Design official',
            'reasoning.none': 'default (this model has no tiers)',
            'reasoning.profile': 'default (follow the profile)',
            'reasoning.hint': 'Empty sends no reasoning field; the profile decides.',
            'action.retry': 'Retry',
            'action.refresh': 'Refresh',
            'action.refreshing': 'Reading…',
            'action.openPanel': 'Open Open Design in the right bar',
            'tab.title': 'Open Design',
            'guide.title': 'Open Design window',
            'guide.description': 'The Open Design web window, embedded in the right bar next to the conversation.',
            'panel.loading': 'Looking for the Open Design window…',
            'panel.failed': 'The panel state could not be read.',
            'panel.retrying': 'It retries automatically, or use the button.',
            'panel.stale': 'address may be stale',
            'panel.reload': 'Reload',
            'panel.member': 'Member: {name}',
            'panel.noMember': 'This is not a Team member session, so there is no member window to show.',
            'panel.notEmbeddable': 'Open Design cannot be embedded here:',
            'panel.openExternal': 'Open in a browser tab',
            'panel.daemonDown': 'The Open Design daemon is not reachable right now.',
            'panel.bridgeHint': 'The bridge tools are unaffected; see the Open Design desktop app for its own window.',
            'panel.unavailable': 'This UI has no right sidebar, or no Session is selected, so the panel cannot be opened.',
          },
        }), 'opendesign-member: dictionaries');

        const t = ctx.locale.bind(NS);

        /**
         * Open this bundle's right-bar tab, or report why that is impossible.
         *
         * The controller throws when no Session is on screen (the column is
         * Session-keyed) or when this composition has no right Sidebar. A button
         * that silently does nothing is the failure mode to avoid, so the reason
         * travels back to the caller to be shown.
         */
        const openPanel = async () => {
          const sidebarRight = ctx.get('sidebarRight');
          if (typeof sidebarRight?.openTab !== 'function') return t('panel.unavailable');
          try {
            sidebarRight.openTab(TAB_KIND);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        };

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'opendesign-member-model',
          order: 20,
          locale: NS,
          label: () => t('section.title'),
        }, (props) => h(ModelSettingsSection, { ...props, t, openPanel })));

        // Optional capability: register the right-bar tab only where the right
        // Sidebar exists. Its absence must cost the panel, never the whole
        // browser half — the model settings above stay usable regardless.
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scoped) => {
          const tabs = scoped.get('sidebarRightTabs');
          if (typeof tabs?.register !== 'function') return;
          scoped.effect(() => tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            // Outside the product: the highest ranking band, so a future
            // builtin of the same kind would not take this one over silently.
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [{
              id: 'window',
              order: 40,
              title: () => t('guide.title'),
              description: () => t('guide.description'),
            }],
          }), 'opendesign-member: right-bar tab type');

          scoped.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
          }, (props) => h(PanelBody, { ...props, t }))), 'opendesign-member: right-bar tab body');
        });
      },
    };
  },

});
