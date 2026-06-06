import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const USAGE_API_URLS = [
    'https://chatgpt.com/backend-api/codex/usage',
    'https://chatgpt.com/backend-api/wham/usage',
];
const PANEL_PROGRESS_BAR_WIDTH = 50;
const MENU_PROGRESS_BAR_WIDTH = 240;

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Codex Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'codex-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'codex-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'codex-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'codex-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codex-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();
        this._updateUsageTitles();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
        } else if (key === 'proxy-url') {
            this._recreateSession();
        } else if (key === 'usage-display') {
            this._updateUsageTitles();
            this._refreshUsage();
        }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._proxyUrl();

        if (proxyUrl !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl, null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _proxyUrl() {
        const configuredProxyUrl = this._settings.get_string('proxy-url').trim();
        if (configuredProxyUrl !== '') {
            return this._normalizeProxyUrl(configuredProxyUrl);
        }

        const envProxyUrl = GLib.getenv('CODEX_USAGE_PROXY_URL')
            ?? GLib.getenv('HTTPS_PROXY')
            ?? GLib.getenv('https_proxy')
            ?? GLib.getenv('HTTP_PROXY')
            ?? GLib.getenv('http_proxy')
            ?? GLib.getenv('ALL_PROXY')
            ?? GLib.getenv('all_proxy')
            ?? '';
        if (envProxyUrl.trim() !== '') {
            return this._normalizeProxyUrl(envProxyUrl.trim());
        }

        const forwarderService = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'systemd',
            'user',
            'codex-electron-proxy-forwarder.service',
        ]));
        if (forwarderService.query_exists(null)) {
            return 'http://127.0.0.1:18080';
        }

        return '';
    }

    _normalizeProxyUrl(proxyUrl) {
        const match = proxyUrl.match(/^(https?:\/\/)([^/@:]+(?:\.[^/@:]+)*|\[[^\]]+\]):(\d+)@([^:]+):(.+)$/);
        if (match) {
            return `${match[1]}${encodeURIComponent(match[4])}:${encodeURIComponent(match[5])}@${match[2]}:${match[3]}`;
        }

        return proxyUrl;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }

        this._session = this._createSession();
        this._refreshUsage();
    }

    _createMenu() {
        const fiveHourBox = new St.BoxLayout({
            style_class: 'codex-usage-section',
            vertical: true,
            x_expand: true,
        });
        const fiveHourHeader = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'codex-section-header',
        });
        this._fiveHourTitle = new St.Label({
            text: '5-Hour Used',
            style_class: 'codex-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        fiveHourHeader.add_child(this._fiveHourTitle);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'codex-percent-label',
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'codex-progress-bg',
            x_expand: true,
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'codex-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'codex-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const weeklyBox = new St.BoxLayout({
            style_class: 'codex-usage-section',
            vertical: true,
            x_expand: true,
        });
        const weeklyHeader = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'codex-section-header',
        });
        this._weeklyTitle = new St.Label({
            text: 'Weekly Used',
            style_class: 'codex-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        weeklyHeader.add_child(this._weeklyTitle);
        this._weeklyPercent = new St.Label({
            text: '...',
            style_class: 'codex-percent-label',
            x_align: Clutter.ActorAlign.END,
        });
        weeklyHeader.add_child(this._weeklyPercent);
        weeklyBox.add_child(weeklyHeader);

        const weeklyProgressBg = new St.Widget({
            style_class: 'codex-progress-bg',
            x_expand: true,
        });
        this._weeklyProgressBar = new St.Widget({
            style_class: 'codex-progress-bar usage-low',
        });
        weeklyProgressBg.add_child(this._weeklyProgressBar);
        weeklyBox.add_child(weeklyProgressBg);

        this._weeklyResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'codex-reset-label',
        });
        weeklyBox.add_child(this._weeklyResetLabel);

        const weeklyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        weeklyItem.add_child(weeklyBox);
        this.menu.addMenuItem(weeklyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sparkBox = new St.BoxLayout({
            style_class: 'codex-usage-section',
            vertical: true,
            x_expand: true,
        });
        const sparkHeader = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'codex-section-header',
        });
        this._sparkTitle = new St.Label({
            text: 'Spark Used',
            style_class: 'codex-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        sparkHeader.add_child(this._sparkTitle);
        this._sparkPercent = new St.Label({
            text: '...',
            style_class: 'codex-percent-label',
            x_align: Clutter.ActorAlign.END,
        });
        sparkHeader.add_child(this._sparkPercent);
        sparkBox.add_child(sparkHeader);

        const sparkProgressBg = new St.Widget({
            style_class: 'codex-progress-bg',
            x_expand: true,
        });
        this._sparkProgressBar = new St.Widget({
            style_class: 'codex-progress-bar usage-low',
        });
        sparkProgressBg.add_child(this._sparkProgressBar);
        sparkBox.add_child(sparkProgressBg);

        this._sparkResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'codex-reset-label',
        });
        sparkBox.add_child(this._sparkResetLabel);

        const sparkItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sparkItem.add_child(sparkBox);
        this.menu.addMenuItem(sparkItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const footerBox = new St.BoxLayout({
            style_class: 'codex-footer-box',
            x_expand: true,
        });
        const refreshContent = new St.BoxLayout({
            style_class: 'codex-refresh-button-content',
        });
        this._refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'codex-refresh-button-icon',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshContent.add_child(this._refreshIcon);
        this._refreshLabel = new St.Label({
            text: 'Refresh',
            style_class: 'codex-refresh-button-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshContent.add_child(this._refreshLabel);
        this._refreshButton = new St.Button({
            style_class: 'codex-refresh-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        this._refreshButton.set_child(refreshContent);
        this._refreshButton.connect('clicked', () => {
            this._refreshUsage();
        });
        footerBox.add_child(this._refreshButton);

        this._lastUpdatedLabel = new St.Label({
            text: 'Checked: —',
            style_class: 'codex-last-updated-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerBox.add_child(this._lastUpdatedLabel);

        footerItem.add_child(footerBox);
        this.menu.addMenuItem(footerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshUsage() {
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const authPath = GLib.build_filenamev([codexHome, 'auth.json']);

        const file = Gio.File.new_for_path(authPath);
        file.load_contents_async(null, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const auth = JSON.parse(decoder.decode(contents));
                const tokens = auth.tokens ?? auth;
                const accessToken = tokens.access_token ?? null;
                const accountId = tokens.account_id ?? null;

                if (!accessToken) {
                    this._setUnavailableState('—', 'Login required');
                    this._updateLastCheckedLabel();
                    return;
                }

                this._fetchUsage(accessToken, accountId);
            } catch (e) {
                console.error('Codex Usage: Failed to read auth:', e.message);
                this._setUnavailableState('—', 'No auth');
                this._updateLastCheckedLabel();
            }
        });
    }

    _fetchUsage(accessToken, accountId) {
        this._fetchUsageEndpoint(accessToken, accountId, 0);
    }

    _fetchUsageEndpoint(accessToken, accountId, index) {
        const url = USAGE_API_URLS[index];
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('User-Agent', 'codex-cli');
        if (accountId) {
            message.request_headers.append('ChatGPT-Account-Id', accountId);
        }

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._tryNextUsageSource(accessToken, accountId, index, `HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const usage = this._normalizeUsagePayload(data);

                    if (!usage.primary && !usage.secondary && !usage.spark) {
                        this._tryNextUsageSource(accessToken, accountId, index, 'No data');
                    } else {
                        this._updateDisplay(usage);
                        this._updateLastCheckedLabel();
                    }
                } catch (e) {
                    console.error('Codex Usage: API request failed:', e.message);
                    this._tryNextUsageSource(accessToken, accountId, index, e.message);
                }
            }
        );
    }

    _tryNextUsageSource(accessToken, accountId, index, reason) {
        if (index + 1 < USAGE_API_URLS.length) {
            this._fetchUsageEndpoint(accessToken, accountId, index + 1);
            return;
        }

        const localUsage = this._loadUsageFromSessions();
        if (localUsage) {
            this._updateDisplay(localUsage);
        } else {
            this._setUnavailableState('Error', reason || 'API failed');
        }
        this._updateLastCheckedLabel();
    }

    _normalizeUsagePayload(data) {
        const root = data?.rate_limit ?? data?.rate_limits ?? data?.usage ?? data;
        return {
            primary: this._findWindow(root, ['primary_window', 'primary', '5h', 'five_hour', 'five-hour']),
            secondary: this._findWindow(root, ['secondary_window', 'secondary', 'weekly', '7d', 'week']),
            spark: this._findSparkWindow(root),
        };
    }

    _loadUsageFromSessions() {
        try {
            const codexHome = GLib.getenv('CODEX_HOME') ??
                GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
            const sessionsDir = GLib.build_filenamev([codexHome, 'sessions']);
            if (!Gio.File.new_for_path(sessionsDir).query_exists(null)) {
                return null;
            }

            const script = [
                `dir=${GLib.shell_quote(sessionsDir)}`,
                'find "$dir" -type f -name "*.jsonl" -printf "%T@ %p\\n" 2>/dev/null | sort -nr | head -n 12 | cut -d" " -f2- | while IFS= read -r file; do tail -n 500 "$file"; done',
            ].join('; ');
            const [, stdout, , status] = GLib.spawn_sync(
                null,
                ['sh', '-lc', script],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            if (status !== 0 || !stdout) {
                return null;
            }

            const lines = new TextDecoder('utf-8').decode(stdout).trim().split('\n').reverse();
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    if (event?.rate_limits) {
                        return this._normalizeUsagePayload(event.rate_limits);
                    }
                } catch {
                    // Ignore non-JSON or partial log lines.
                }
            }
        } catch (e) {
            console.error('Codex Usage: Failed to read local sessions:', e.message);
        }

        return null;
    }

    _findWindow(root, names) {
        if (!root) {
            return null;
        }

        for (const name of names) {
            const value = this._getCaseInsensitive(root, name);
            const normalized = this._normalizeWindow(value);
            if (normalized) {
                return normalized;
            }
        }

        return this._walkForWindow(root, (key, value) => {
            const normalizedKey = key.toLowerCase().replace(/_/g, '-');
            if (!names.some(name => normalizedKey.includes(name.replace(/_/g, '-')))) {
                return null;
            }

            return this._normalizeWindow(value);
        });
    }

    _findSparkWindow(root) {
        if (!root) {
            return null;
        }

        const direct = this._normalizeWindow(root.individual_limit);
        if (direct) {
            return direct;
        }

        return this._walkForWindow(root, (key, value) => {
            const text = `${key} ${value?.model ?? ''} ${value?.limit_id ?? ''} ${value?.limit_name ?? ''}`.toLowerCase();
            if (!text.includes('spark')) {
                return null;
            }

            return this._normalizeWindow(value) ?? this._walkForWindow(value, (_nestedKey, nestedValue) => {
                return this._normalizeWindow(nestedValue);
            });
        });
    }

    _walkForWindow(value, matcher) {
        if (!value || typeof value !== 'object') {
            return null;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const nested = this._walkForWindow(item, matcher);
                if (nested) {
                    return nested;
                }
            }
            return null;
        }

        for (const [key, child] of Object.entries(value)) {
            const matched = matcher(key, child);
            if (matched) {
                return matched;
            }
            const nested = this._walkForWindow(child, matcher);
            if (nested) {
                return nested;
            }
        }

        return null;
    }

    _getCaseInsensitive(object, name) {
        if (!object || typeof object !== 'object') {
            return null;
        }

        const target = name.toLowerCase();
        for (const [key, value] of Object.entries(object)) {
            if (key.toLowerCase() === target) {
                return value;
            }
        }

        return null;
    }

    _normalizeWindow(window) {
        if (!window || typeof window !== 'object') {
            return null;
        }

        let usedPercent = window.used_percent
            ?? window.usedPercent
            ?? window.usage_percent
            ?? window.usagePercent
            ?? window.percent_used
            ?? window.percentUsed
            ?? null;
        const remainingPercent = window.remaining_percent ?? window.remainingPercent ?? null;
        if (usedPercent == null && typeof remainingPercent === 'number') {
            usedPercent = 100 - remainingPercent;
        }

        if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
            return null;
        }

        return {
            used_percent: this._coercePercent(usedPercent),
            reset_at: this._normalizeResetTime(
                window.reset_at
                ?? window.resetAt
                ?? window.resets_at
                ?? window.resetsAt
                ?? null
            ),
        };
    }

    _normalizeResetTime(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return new Date(value * 1000).toISOString();
        }
        if (typeof value === 'string' && value.trim() !== '') {
            return value;
        }

        return null;
    }

    _coercePercent(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    _setUnavailableState(label, detail) {
        this._label.set_text(label);
        this._fiveHourPercent.set_text(detail);
        this._weeklyPercent.set_text('—');
        this._fiveHourResetLabel.set_text('Resets: —');
        this._weeklyResetLabel.set_text('Resets: —');
        this._sparkPercent.set_text('—');
        this._sparkResetLabel.set_text('Resets: —');
        this._updatePanelProgressBar(0);
        this._updateProgressBar(this._fiveHourProgressBar, 0);
        this._updateProgressBar(this._weeklyProgressBar, 0);
        this._updateProgressBar(this._sparkProgressBar, 0);
    }

    _updateDisplay(data) {
        const primaryUsed = this._usedPercent(data.primary?.used_percent);
        const secondaryUsed = this._usedPercent(data.secondary?.used_percent);
        const sparkUsed = data.spark ? this._usedPercent(data.spark.used_percent) : null;
        const primaryDisplay = this._displayPercent(primaryUsed);
        const secondaryDisplay = this._displayPercent(secondaryUsed);
        const sparkDisplay = sparkUsed == null ? null : this._displayPercent(sparkUsed);
        const displaySuffix = this._usageDisplayMode() === 'remaining' ? 'remaining' : 'used';

        this._label.set_text(`${Math.round(primaryDisplay)}%`);

        this._updatePanelProgressBar(primaryDisplay);

        this._fiveHourPercent.set_text(`${primaryDisplay.toFixed(1)}% ${displaySuffix}`);
        this._updateProgressBar(this._fiveHourProgressBar, primaryDisplay);

        this._weeklyPercent.set_text(`${secondaryDisplay.toFixed(1)}% ${displaySuffix}`);
        this._updateProgressBar(this._weeklyProgressBar, secondaryDisplay);

        if (sparkDisplay == null) {
            this._sparkPercent.set_text('No data');
            this._updateProgressBar(this._sparkProgressBar, 0);
            this._sparkResetLabel.set_text('Resets: —');
        } else {
            this._sparkPercent.set_text(`${sparkDisplay.toFixed(1)}% ${displaySuffix}`);
            this._updateProgressBar(this._sparkProgressBar, sparkDisplay);
            if (data.spark?.reset_at) {
                this._sparkResetLabel.set_text(
                    `Resets in ${this._formatResetTime(data.spark.reset_at)}`
                );
            } else {
                this._sparkResetLabel.set_text('Resets: —');
            }
        }

        if (data.primary?.reset_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.primary.reset_at)}`
            );
        } else {
            this._fiveHourResetLabel.set_text('Resets: —');
        }

        if (data.secondary?.reset_at) {
            this._weeklyResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.secondary.reset_at)}`
            );
        } else {
            this._weeklyResetLabel.set_text('Resets: —');
        }
    }

    _updatePanelProgressBar(usage) {
        const maxWidth = this._panelProgressBg.width > 0
            ? this._panelProgressBg.width
            : PANEL_PROGRESS_BAR_WIDTH;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _updateProgressBar(progressBar, usage) {
        const normalizedUsage = this._usedPercent(usage);
        const progressBg = progressBar.get_parent();
        const maxWidth = progressBg?.width > 0
            ? progressBg.width
            : MENU_PROGRESS_BAR_WIDTH;
        const width = Math.round((normalizedUsage / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (this._usageDisplayMode() === 'remaining') {
            if (normalizedUsage <= 10) {
                progressBar.add_style_class_name('usage-critical');
            } else if (normalizedUsage <= 30) {
                progressBar.add_style_class_name('usage-high');
            } else if (normalizedUsage <= 60) {
                progressBar.add_style_class_name('usage-medium');
            } else {
                progressBar.add_style_class_name('usage-low');
            }
        } else {
            if (normalizedUsage >= 90) {
                progressBar.add_style_class_name('usage-critical');
            } else if (normalizedUsage >= 70) {
                progressBar.add_style_class_name('usage-high');
            } else if (normalizedUsage >= 40) {
                progressBar.add_style_class_name('usage-medium');
            } else {
                progressBar.add_style_class_name('usage-low');
            }
        }
    }

    _usedPercent(usedPercent) {
        return Math.min(100, Math.max(0, this._coercePercent(usedPercent)));
    }

    _displayPercent(usedPercent) {
        const normalizedUsage = this._usedPercent(usedPercent);
        if (this._usageDisplayMode() === 'remaining') {
            return 100 - normalizedUsage;
        }

        return normalizedUsage;
    }

    _usageDisplayMode() {
        return this._settings.get_string('usage-display');
    }

    _updateUsageTitles() {
        const suffix = this._usageDisplayMode() === 'remaining' ? 'Remaining' : 'Used';
        this._fiveHourTitle.set_text(`5-Hour ${suffix}`);
        this._weeklyTitle.set_text(`Weekly ${suffix}`);
        this._sparkTitle.set_text(`Spark ${suffix}`);
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '—';
        }
    }

    _updateLastCheckedLabel() {
        const now = GLib.DateTime.new_now_local();
        this._lastUpdatedLabel.set_text(`Checked: ${now.format('%H:%M:%S')}`);
    }

    destroy() {
        this._stopTimer();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CodexUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
