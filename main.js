const { Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_FOCUS_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const MIN_FOCUS_MINUTES = 1;
const MAX_FOCUS_MINUTES = 120;
const MIN_BREAK_MINUTES = 1;
const MAX_BREAK_MINUTES = 60;
const BODY_CLASS_ACTIVE = "focus-mode-pomodoro-active";
const BODY_CLASS_HIDE_RIBBON = "focus-mode-pomodoro-hide-ribbon";
const BODY_CLASS_HIDE_SIDEBARS = "focus-mode-pomodoro-hide-sidebars";
const BODY_CLASS_DIM_STATUS = "focus-mode-pomodoro-dim-status";
const MODE_FOCUS = "focus";
const MODE_BREAK = "break";

const DEFAULT_SETTINGS = {
  autoStartTimer: true,
  autoStartBreak: true,
  focusDurationMinutes: DEFAULT_FOCUS_MINUTES,
  breakDurationMinutes: DEFAULT_BREAK_MINUTES,
  hideRibbon: true,
  hideSidebars: true,
  dimStatusBar: true,
  restoreSessionOnLoad: true,
  panelPosition: null
};

const DEFAULT_SESSION = {
  active: false,
  mode: MODE_FOCUS,
  timerRunning: false,
  remainingSeconds: DEFAULT_FOCUS_MINUTES * 60,
  startedAt: null,
  endsAt: null,
  completedFocusSessions: 0
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(number)));
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const seconds = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function setBodyClass(className, enabled) {
  document.body.classList.toggle(className, Boolean(enabled));
}

function logFocusModeWarning(message, error) {
  console.warn(`[Focus Mode Pomodoro] ${message}`, error);
}

function normalizeSettings(settings) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  merged.autoStartTimer = Boolean(merged.autoStartTimer);
  merged.autoStartBreak = Boolean(merged.autoStartBreak);
  merged.focusDurationMinutes = clampNumber(
    merged.focusDurationMinutes,
    MIN_FOCUS_MINUTES,
    MAX_FOCUS_MINUTES,
    DEFAULT_FOCUS_MINUTES
  );
  merged.breakDurationMinutes = clampNumber(
    merged.breakDurationMinutes,
    MIN_BREAK_MINUTES,
    MAX_BREAK_MINUTES,
    DEFAULT_BREAK_MINUTES
  );
  merged.hideRibbon = Boolean(merged.hideRibbon);
  merged.hideSidebars = Boolean(merged.hideSidebars);
  merged.dimStatusBar = Boolean(merged.dimStatusBar);
  merged.restoreSessionOnLoad = Boolean(merged.restoreSessionOnLoad);
  merged.panelPosition = settings?.panelPosition &&
    Number.isFinite(settings.panelPosition.x) &&
    Number.isFinite(settings.panelPosition.y)
      ? { x: Math.round(settings.panelPosition.x), y: Math.round(settings.panelPosition.y) }
      : null;
  return merged;
}

function getDurationSeconds(settings, mode) {
  return (mode === MODE_BREAK ? settings.breakDurationMinutes : settings.focusDurationMinutes) * 60;
}

function getDurationMinutes(settings, mode) {
  return mode === MODE_BREAK ? settings.breakDurationMinutes : settings.focusDurationMinutes;
}

function normalizeSession(session, settings) {
  const merged = Object.assign({}, DEFAULT_SESSION, session || {});
  merged.mode = merged.mode === MODE_BREAK ? MODE_BREAK : MODE_FOCUS;

  const modeDuration = getDurationSeconds(settings, merged.mode);
  if (!Number.isFinite(merged.remainingSeconds)) {
    merged.remainingSeconds = modeDuration;
  }

  merged.remainingSeconds = Math.max(0, Math.min(modeDuration, Math.floor(merged.remainingSeconds)));
  merged.startedAt = Number.isFinite(merged.startedAt) ? merged.startedAt : null;
  merged.endsAt = Number.isFinite(merged.endsAt) ? merged.endsAt : null;
  merged.completedFocusSessions = Math.max(0, Math.floor(Number(merged.completedFocusSessions) || 0));
  merged.active = Boolean(merged.active);
  merged.timerRunning = Boolean(merged.timerRunning);
  return merged;
}

function getModeLabel(mode) {
  return mode === MODE_BREAK ? "Перерыв" : "Фокус";
}

function getNextMode(mode) {
  return mode === MODE_BREAK ? MODE_FOCUS : MODE_BREAK;
}

module.exports = class FocusModePomodoroPlugin extends Plugin {
  async onload() {
    await this.loadPluginData();
    this.removeStaleStatusItems();

    this.ribbonIconEl = this.addRibbonIcon("timer", "Focus Mode Pomodoro", () => {
      void this.toggleFocusMode();
    });

    this.addCommand({
      id: "toggle-focus-mode",
      name: "Включить/выключить режим концентрации",
      callback: () => void this.toggleFocusMode()
    });

    this.addCommand({
      id: "start-pomodoro",
      name: "Запустить таймер",
      callback: () => void this.startTimer()
    });

    this.addCommand({
      id: "pause-resume-pomodoro",
      name: "Пауза/продолжить таймер",
      callback: () => void this.toggleTimer()
    });

    this.addCommand({
      id: "reset-pomodoro",
      name: "Сбросить таймер",
      callback: () => void this.resetTimer()
    });

    this.addCommand({
      id: "switch-pomodoro-mode",
      name: "Переключить Фокус/Перерыв",
      callback: () => void this.switchMode(getNextMode(this.session.mode))
    });

    this.addSettingTab(new FocusModeSettingTab(this.app, this));

    if (this.session.timerRunning) {
      this.recalculateRemainingFromClock();
    }

    if (this.session.active && this.settings.restoreSessionOnLoad) {
      await this.enableFocusMode({ fromRestore: true, showNotice: false, skipAutoStart: true });
    } else {
      const completedFocusSessions = this.session.completedFocusSessions;
      this.session = this.createFreshSession(MODE_FOCUS, completedFocusSessions);
      await this.enableFocusMode({ showNotice: false });
    }

    if (!this.session.active) {
      this.removeFocusModeClasses();
      this.removePanel();
    }

    this.updateDisplay();

    this.register(() => {
      this.clearTicker();
      void this.exitFocusWorkspace();
      this.removePanel();
      this.removeStaleStatusItems();
    });
  }

  onunload() {
    this.clearTicker();
    void this.exitFocusWorkspace();
    this.removePanel();
    this.removeStaleStatusItems();
  }

  async loadPluginData() {
    const data = (await this.loadData()) || {};
    this.settings = normalizeSettings(data.settings);
    this.session = normalizeSession(data.session, this.settings);
  }

  async persist() {
    await this.saveData({
      settings: this.settings,
      session: this.session
    });
  }

  createFreshSession(mode, completedFocusSessions = this.session?.completedFocusSessions || 0) {
    return Object.assign({}, DEFAULT_SESSION, {
      mode,
      remainingSeconds: getDurationSeconds(this.settings, mode),
      completedFocusSessions
    });
  }

  async toggleFocusMode() {
    if (this.session.active) {
      await this.disableFocusMode();
      return;
    }

    await this.enableFocusMode();
  }

  async enableFocusMode(options = {}) {
    const { fromRestore = false, showNotice = true, skipAutoStart = false } = options;
    this.session.active = true;
    await this.enterFocusWorkspace();
    this.ensurePanel();

    if (this.session.timerRunning) {
      this.startTicker();
    } else if (this.settings.autoStartTimer && !fromRestore && !skipAutoStart) {
      await this.startTimer(false);
    }

    this.updateDisplay();
    await this.persist();

    if (showNotice) {
      new Notice("Focus Mode включён");
    }
  }

  async disableFocusMode() {
    this.session = this.createFreshSession(MODE_FOCUS);
    await this.exitFocusWorkspace();
    this.clearTicker();
    this.removePanel();
    this.removeStaleStatusItems();
    this.updateDisplay();
    await this.persist();
    new Notice("Focus Mode выключен");
  }

  async exitAndDisablePlugin() {
    this.session = this.createFreshSession(MODE_FOCUS);
    await this.exitFocusWorkspace();
    this.clearTicker();
    this.removePanel();
    this.removeStaleStatusItems();
    this.ribbonIconEl?.remove();
    this.ribbonIconEl = null;
    this.updateDisplay();
    await this.persist();

    const pluginManager = this.app?.plugins;
    if (pluginManager?.disablePluginAndSave) {
      try {
        await pluginManager.disablePluginAndSave(this.manifest.id);
        return;
      } catch (error) {
        logFocusModeWarning("Failed to disable and save plugin state through Obsidian plugin manager.", error);
      }
    }

    const removedFromCommunityList = await this.removePluginFromCommunityList();
    if (pluginManager?.disablePlugin) {
      try {
        await pluginManager.disablePlugin(this.manifest.id);
        return;
      } catch (error) {
        logFocusModeWarning("Failed to disable plugin through Obsidian plugin manager.", error);
      }
    }

    if (removedFromCommunityList) {
      new Notice("Плагин отключён в Community plugins.");
      return;
    }

    new Notice("Focus Mode выключен. Отключите плагин в Community plugins.");
  }

  async removePluginFromCommunityList() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter?.read || !adapter?.write) {
      return false;
    }

    const configDir = this.app?.vault?.configDir || ".obsidian";
    const communityPluginsPath = `${configDir}/community-plugins.json`;

    try {
      const raw = await adapter.read(communityPluginsPath);
      const plugins = JSON.parse(raw);
      if (!Array.isArray(plugins)) {
        return false;
      }

      const nextPlugins = plugins.filter((id) => id !== this.manifest.id);
      await adapter.write(communityPluginsPath, JSON.stringify(nextPlugins, null, 2));
      return true;
    } catch (error) {
      logFocusModeWarning("Не удалось обновить community-plugins.json.", error);
      return false;
    }
  }

  async startTimer(showNotice = true) {
    if (!this.session.active) {
      await this.enableFocusMode({ showNotice: false, skipAutoStart: true });
    }

    if (this.session.remainingSeconds <= 0) {
      this.session.remainingSeconds = getDurationSeconds(this.settings, this.session.mode);
    }

    this.session.timerRunning = true;
    this.session.startedAt = this.session.startedAt || Date.now();
    this.session.endsAt = Date.now() + this.session.remainingSeconds * 1000;

    this.startTicker();
    this.updateDisplay();
    await this.persist();

    if (showNotice) {
      new Notice(`${getModeLabel(this.session.mode)}: таймер запущен`);
    }
  }

  async toggleTimer() {
    if (!this.session.active) {
      await this.startTimer();
      return;
    }

    if (this.session.timerRunning) {
      await this.pauseTimer();
    } else {
      await this.startTimer();
    }
  }

  async pauseTimer() {
    this.recalculateRemainingFromClock();
    this.session.timerRunning = false;
    this.session.endsAt = null;
    this.clearTicker();
    this.updateDisplay();
    await this.persist();
    new Notice("Таймер поставлен на паузу");
  }

  async resetTimer() {
    const wasActive = this.session.active;
    const completedFocusSessions = this.session.completedFocusSessions;
    this.session = this.createFreshSession(this.session.mode, completedFocusSessions);
    this.session.active = wasActive;
    this.clearTicker();
    if (wasActive) {
      await this.enterFocusWorkspace();
      this.ensurePanel();
    }
    this.updateDisplay();
    await this.persist();
    new Notice(`${getModeLabel(this.session.mode)}: таймер сброшен`);
  }

  async switchMode(mode) {
    const wasActive = this.session.active;
    const nextMode = mode === MODE_BREAK ? MODE_BREAK : MODE_FOCUS;
    const completedFocusSessions = this.session.completedFocusSessions;
    this.session = this.createFreshSession(nextMode, completedFocusSessions);
    this.session.active = wasActive;
    this.clearTicker();
    if (wasActive) {
      await this.enterFocusWorkspace();
      this.ensurePanel();
    }
    this.updateDisplay();
    await this.persist();
    new Notice(`Режим таймера: ${getModeLabel(nextMode)}`);
  }

  startTicker() {
    if (this.timerIntervalId) {
      return;
    }

    this.timerIntervalId = window.setInterval(() => {
      void this.tick();
    }, 1000);
  }

  clearTicker() {
    if (!this.timerIntervalId) {
      return;
    }

    window.clearInterval(this.timerIntervalId);
    this.timerIntervalId = null;
  }

  async tick() {
    if (!this.session.timerRunning) {
      return;
    }

    this.recalculateRemainingFromClock();

    if (this.session.remainingSeconds <= 0) {
      await this.completeTimer();
      return;
    }

    this.updateDisplay();
    await this.persist();
  }

  async completeTimer() {
    const completedMode = this.session.mode;
    this.clearTicker();

    if (completedMode === MODE_FOCUS) {
      const completedFocusSessions = this.session.completedFocusSessions + 1;
      this.session = this.createFreshSession(MODE_BREAK, completedFocusSessions);
      this.session.active = true;

      if (this.settings.autoStartBreak) {
        this.session.timerRunning = true;
        this.session.startedAt = Date.now();
        this.session.endsAt = Date.now() + this.session.remainingSeconds * 1000;
        this.startTicker();
        new Notice("Фокус-сессия завершена. Запущен короткий перерыв.");
      } else {
        new Notice("Фокус-сессия завершена. Можно начать перерыв.");
      }
    } else {
      const completedFocusSessions = this.session.completedFocusSessions;
      this.session = this.createFreshSession(MODE_FOCUS, completedFocusSessions);
      this.session.active = true;
      new Notice("Перерыв завершён. Можно начать следующую фокус-сессию.");
    }

    this.updateDisplay();
    await this.persist();
  }

  recalculateRemainingFromClock() {
    if (!this.session.endsAt) {
      return;
    }

    const remaining = Math.ceil((this.session.endsAt - Date.now()) / 1000);
    this.session.remainingSeconds = Math.max(0, remaining);
  }

  applyFocusModeClasses() {
    setBodyClass(BODY_CLASS_ACTIVE, this.session.active);
    setBodyClass(BODY_CLASS_HIDE_RIBBON, this.session.active && this.settings.hideRibbon);
    setBodyClass(BODY_CLASS_HIDE_SIDEBARS, this.session.active && this.settings.hideSidebars);
    setBodyClass(BODY_CLASS_DIM_STATUS, this.session.active && this.settings.dimStatusBar);
  }

  async enterFocusWorkspace() {
    this.applyFocusModeClasses();

    if (!this.settings.hideSidebars) {
      return;
    }

    try {
      this.captureFocusWorkspaceState();
      await this.collapseWorkspaceSplit(this.app?.workspace?.leftSplit);
      await this.collapseWorkspaceSplit(this.app?.workspace?.rightSplit);
      this.app?.workspace?.requestSaveLayout?.();
    } catch (error) {
      logFocusModeWarning("Не удалось свернуть боковые панели.", error);
    }
  }

  async exitFocusWorkspace() {
    try {
      await this.restoreFocusWorkspaceState();
    } catch (error) {
      logFocusModeWarning("Не удалось восстановить боковые панели.", error);
    }
    this.removeFocusModeClasses();
  }

  async refreshFocusWorkspace() {
    if (!this.session.active) {
      this.removeFocusModeClasses();
      return;
    }

    this.applyFocusModeClasses();

    if (this.settings.hideSidebars) {
      await this.enterFocusWorkspace();
    } else {
      await this.restoreFocusWorkspaceState();
    }
  }

  captureFocusWorkspaceState() {
    if (this.focusWorkspaceState) {
      return;
    }

    const workspace = this.app?.workspace;
    this.focusWorkspaceState = {
      leftCollapsed: this.isWorkspaceSplitCollapsed(workspace?.leftSplit),
      rightCollapsed: this.isWorkspaceSplitCollapsed(workspace?.rightSplit)
    };
  }

  async restoreFocusWorkspaceState() {
    const state = this.focusWorkspaceState;
    if (!state) {
      return;
    }

    const workspace = this.app?.workspace;

    if (!state.leftCollapsed) {
      await this.expandWorkspaceSplit(workspace?.leftSplit);
    }

    if (!state.rightCollapsed) {
      await this.expandWorkspaceSplit(workspace?.rightSplit);
    }

    this.focusWorkspaceState = null;
    workspace?.requestSaveLayout?.();
  }

  isWorkspaceSplitCollapsed(split) {
    if (!split) {
      return true;
    }

    return Boolean(
      split.collapsed ||
      split.containerEl?.classList?.contains("is-collapsed") ||
      split.containerEl?.classList?.contains("mod-collapsed")
    );
  }

  async collapseWorkspaceSplit(split) {
    if (!split || this.isWorkspaceSplitCollapsed(split)) {
      return;
    }

    if (typeof split.collapse === "function") {
      await split.collapse();
    } else if (typeof split.setCollapsed === "function") {
      await split.setCollapsed(true);
    } else {
      split.containerEl?.classList?.add("is-collapsed", "mod-collapsed");
    }
  }

  async expandWorkspaceSplit(split) {
    if (!split) {
      return;
    }

    if (typeof split.expand === "function") {
      await split.expand();
    } else if (typeof split.setCollapsed === "function") {
      await split.setCollapsed(false);
    } else {
      split.containerEl?.classList?.remove("is-collapsed", "mod-collapsed");
    }
  }

  removeFocusModeClasses() {
    document.body.classList.remove(
      BODY_CLASS_ACTIVE,
      BODY_CLASS_HIDE_RIBBON,
      BODY_CLASS_HIDE_SIDEBARS,
      BODY_CLASS_DIM_STATUS
    );
  }

  ensurePanel() {
    if (this.panelEl) {
      return;
    }

    this.panelEl = document.createElement("section");
    this.panelEl.className = "focus-mode-pomodoro-panel";
    this.panelEl.setAttribute("aria-label", "Focus Mode Pomodoro");
    document.body.appendChild(this.panelEl);
    this.applyPanelPosition();

    this.registerDomEvent(this.panelEl, "click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button[data-action]") : null;
      if (!button) {
        return;
      }

      const action = button.getAttribute("data-action");
      if (action === "toggle-timer") {
        void this.toggleTimer();
      } else if (action === "reset") {
        void this.resetTimer();
      } else if (action === "switch-mode") {
        void this.switchMode(getNextMode(this.session.mode));
      } else if (action === "close") {
        void this.exitAndDisablePlugin();
      }
    });

    this.registerDomEvent(this.panelEl, "change", (event) => {
      const target = event.target;
      if (!target || !target.matches || !target.matches("input[data-action='duration']")) {
        return;
      }

      void this.applyDurationInput(target.value);
    });

    this.registerDomEvent(this.panelEl, "keydown", (event) => {
      const target = event.target;
      if (!target || !target.matches || !target.matches("input[data-action='duration']")) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        target.blur();
      } else if (event.key === "Escape") {
        target.value = String(getDurationMinutes(this.settings, this.session.mode));
        target.blur();
      }
    });

    this.registerDomEvent(this.panelEl, "pointerdown", (event) => {
      this.startPanelDrag(event);
    });
  }

  removePanel() {
    if (!this.panelEl) {
      return;
    }

    this.panelEl.remove();
    this.panelEl = null;
  }

  applyPanelPosition() {
    if (!this.panelEl) {
      return;
    }

    const position = this.settings.panelPosition;
    if (!position) {
      this.panelEl.style.left = "";
      this.panelEl.style.top = "";
      this.panelEl.style.right = "";
      this.panelEl.style.bottom = "";
      return;
    }

    const rect = this.panelEl.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    const x = Math.max(8, Math.min(position.x, maxX));
    const y = Math.max(8, Math.min(position.y, maxY));

    this.settings.panelPosition = { x, y };
    this.panelEl.style.left = `${x}px`;
    this.panelEl.style.top = `${y}px`;
    this.panelEl.style.right = "auto";
    this.panelEl.style.bottom = "auto";
  }

  startPanelDrag(event) {
    if (event.button !== 0 || !this.panelEl) {
      return;
    }

    const target = event.target;
    if (!target || !target.closest) {
      return;
    }

    if (target.closest("input, button, select, textarea")) {
      return;
    }

    if (!target.closest(".focus-mode-pomodoro-panel__header")) {
      return;
    }

    const rect = this.panelEl.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    event.preventDefault();
    this.panelEl.classList.add("is-dragging");

    const movePanel = (moveEvent) => {
      if (!this.panelEl) {
        return;
      }

      const currentRect = this.panelEl.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - currentRect.width - 8);
      const maxY = Math.max(8, window.innerHeight - currentRect.height - 8);
      const x = Math.max(8, Math.min(moveEvent.clientX - offsetX, maxX));
      const y = Math.max(8, Math.min(moveEvent.clientY - offsetY, maxY));

      this.settings.panelPosition = { x, y };
      this.applyPanelPosition();
    };

    const stopDrag = () => {
      window.removeEventListener("pointermove", movePanel);
      this.panelEl?.classList.remove("is-dragging");
      void this.persist();
    };

    window.addEventListener("pointermove", movePanel);
    window.addEventListener("pointerup", stopDrag, { once: true });
  }

  removeStaleStatusItems() {
    document.querySelectorAll(".focus-mode-pomodoro-status, .focus-mode-pomodoro-panel").forEach((element) => {
      if (element !== this.panelEl) {
        element.remove();
      }
    });

    document.querySelectorAll(".status-bar-item").forEach((element) => {
      const text = (element.textContent || "").trim();
      const title = element.getAttribute("title") || "";
      const ariaLabel = element.getAttribute("aria-label") || "";
      const marker = `${text} ${title} ${ariaLabel}`;
      const className = String(element.className || "");

      if (
        className.includes("plugin-sync") ||
        marker.includes("Focus Mode Pomodoro") ||
        marker.includes("Focus Mode") ||
        marker.includes("Pomodoro")
      ) {
        element.remove();
      }
    });
  }

  getProgressPercent() {
    const duration = getDurationSeconds(this.settings, this.session.mode);
    if (duration <= 0) {
      return 0;
    }

    const elapsed = duration - this.session.remainingSeconds;
    return Math.max(0, Math.min(100, (elapsed / duration) * 100));
  }

  async applyDurationInput(value) {
    const mode = this.session.mode;
    const minutes = mode === MODE_BREAK
      ? clampNumber(value, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES, DEFAULT_BREAK_MINUTES)
      : clampNumber(value, MIN_FOCUS_MINUTES, MAX_FOCUS_MINUTES, DEFAULT_FOCUS_MINUTES);

    if (mode === MODE_BREAK) {
      this.settings.breakDurationMinutes = minutes;
    } else {
      this.settings.focusDurationMinutes = minutes;
    }

    this.session.remainingSeconds = minutes * 60;
    this.session.startedAt = this.session.timerRunning ? Date.now() : null;
    this.session.endsAt = this.session.timerRunning ? Date.now() + this.session.remainingSeconds * 1000 : null;
    this.updateDisplay();
    await this.persist();
    new Notice(`${getModeLabel(mode)}: установлено ${minutes} мин.`);
  }

  isEditingDurationInput() {
    const activeElement = document.activeElement;
    return Boolean(
      activeElement &&
      activeElement.matches &&
      activeElement.matches(".focus-mode-pomodoro-panel__duration-input")
    );
  }

  updateDisplay() {
    const active = this.session.active;
    const timeText = formatTime(this.session.remainingSeconds);

    this.removeStaleStatusItems();

    if (!active) {
      this.removePanel();
    }

    if (this.ribbonIconEl) {
      this.ribbonIconEl.classList.toggle("is-active", active);
    }

    if (this.panelEl && !this.isEditingDurationInput()) {
      this.renderPanel(timeText);
      this.applyPanelPosition();
    }
  }

  renderPanel(timeText) {
    this.panelEl.replaceChildren();

    const header = document.createElement("div");
    header.className = "focus-mode-pomodoro-panel__header";

    const marker = document.createElement("span");
    marker.className = this.session.timerRunning
      ? "focus-mode-pomodoro-panel__marker is-running"
      : "focus-mode-pomodoro-panel__marker";
    marker.setAttribute("aria-hidden", "true");

    const title = document.createElement("strong");
    title.textContent = "Focus Mode";

    const modeControl = document.createElement("label");
    modeControl.className = "focus-mode-pomodoro-panel__mode-control";

    const modeBadge = document.createElement("span");
    modeBadge.className = this.session.mode === MODE_BREAK
      ? "focus-mode-pomodoro-panel__badge is-break"
      : "focus-mode-pomodoro-panel__badge";
    modeBadge.textContent = getModeLabel(this.session.mode);

    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.min = String(this.session.mode === MODE_BREAK ? MIN_BREAK_MINUTES : MIN_FOCUS_MINUTES);
    durationInput.max = String(this.session.mode === MODE_BREAK ? MAX_BREAK_MINUTES : MAX_FOCUS_MINUTES);
    durationInput.step = "1";
    durationInput.value = String(getDurationMinutes(this.settings, this.session.mode));
    durationInput.className = "focus-mode-pomodoro-panel__duration-input";
    durationInput.dataset.action = "duration";
    durationInput.setAttribute("aria-label", `${getModeLabel(this.session.mode)} в минутах`);

    const durationUnit = document.createElement("span");
    durationUnit.className = "focus-mode-pomodoro-panel__duration-unit";
    durationUnit.textContent = "мин";

    modeControl.append(modeBadge, durationInput, durationUnit);
    header.append(marker, title, modeControl);

    const timer = document.createElement("div");
    timer.className = "focus-mode-pomodoro-panel__timer";
    timer.textContent = timeText;

    const progress = document.createElement("div");
    progress.className = "focus-mode-pomodoro-panel__progress";
    progress.setAttribute("aria-hidden", "true");

    const progressFill = document.createElement("div");
    progressFill.className = "focus-mode-pomodoro-panel__progress-fill";
    progressFill.style.width = `${this.getProgressPercent()}%`;
    progress.appendChild(progressFill);

    const subtitle = document.createElement("div");
    subtitle.className = "focus-mode-pomodoro-panel__subtitle";
    if (this.session.timerRunning) {
      subtitle.textContent = this.session.mode === MODE_BREAK ? "Короткий перерыв идёт" : "Фокус-сессия идёт";
    } else {
      subtitle.textContent = "Таймер на паузе";
    }

    const counter = document.createElement("div");
    counter.className = "focus-mode-pomodoro-panel__counter";
    counter.textContent = `Фокус-сессий: ${this.session.completedFocusSessions}`;

    const actions = document.createElement("div");
    actions.className = "focus-mode-pomodoro-panel__actions";
    actions.append(
      this.createPanelButton("toggle-timer", this.session.timerRunning ? "Пауза" : "Старт"),
      this.createPanelButton("reset", "Сброс"),
      this.createPanelButton("switch-mode", this.session.mode === MODE_BREAK ? "Фокус" : "Перерыв"),
      this.createPanelButton("close", "Выход")
    );

    this.panelEl.append(header, timer, progress, subtitle, counter, actions);
  }

  createPanelButton(action, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "focus-mode-pomodoro-panel__button";
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }
};

class FocusModeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.replaceChildren();

    const title = document.createElement("h2");
    title.textContent = "Focus Mode Pomodoro";
    containerEl.appendChild(title);

    new Setting(containerEl)
      .setName("Длительность фокуса")
      .setDesc(`Сейчас: ${this.plugin.settings.focusDurationMinutes} мин. Новое значение применяется к следующему запуску или сбросу.`)
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_FOCUS_MINUTES))
          .setValue(String(this.plugin.settings.focusDurationMinutes))
          .onChange(async (value) => {
            this.plugin.settings.focusDurationMinutes = clampNumber(
              value,
              MIN_FOCUS_MINUTES,
              MAX_FOCUS_MINUTES,
              DEFAULT_FOCUS_MINUTES
            );
            await this.plugin.persist();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Длительность перерыва")
      .setDesc(`Сейчас: ${this.plugin.settings.breakDurationMinutes} мин. Перерыв запускается после фокус-сессии.`)
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_BREAK_MINUTES))
          .setValue(String(this.plugin.settings.breakDurationMinutes))
          .onChange(async (value) => {
            this.plugin.settings.breakDurationMinutes = clampNumber(
              value,
              MIN_BREAK_MINUTES,
              MAX_BREAK_MINUTES,
              DEFAULT_BREAK_MINUTES
            );
            await this.plugin.persist();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Автоматически запускать таймер")
      .setDesc("При включении Focus Mode сразу запускается фокус-сессия.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoStartTimer).onChange(async (value) => {
          this.plugin.settings.autoStartTimer = value;
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Автоматически запускать перерыв")
      .setDesc("После завершения фокус-сессии плагин переключится на короткий перерыв и запустит его.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoStartBreak).onChange(async (value) => {
          this.plugin.settings.autoStartBreak = value;
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Скрывать левую ленту")
      .setDesc("Убирает ribbon-панель Obsidian на время режима концентрации.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hideRibbon).onChange(async (value) => {
          this.plugin.settings.hideRibbon = value;
          await this.plugin.refreshFocusWorkspace();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Скрывать боковые панели")
      .setDesc("Убирает левый и правый сайдбары, чтобы заметка занимала больше места.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hideSidebars).onChange(async (value) => {
          this.plugin.settings.hideSidebars = value;
          await this.plugin.refreshFocusWorkspace();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Приглушать строку состояния")
      .setDesc("Строка состояния остаётся доступной, но визуально меньше отвлекает.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.dimStatusBar).onChange(async (value) => {
          this.plugin.settings.dimStatusBar = value;
          await this.plugin.refreshFocusWorkspace();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Восстанавливать активную сессию")
      .setDesc("Если Obsidian был перезапущен во время сессии, плагин восстановит Focus Mode.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.restoreSessionOnLoad).onChange(async (value) => {
          this.plugin.settings.restoreSessionOnLoad = value;
          await this.plugin.persist();
        });
      });
  }
}
