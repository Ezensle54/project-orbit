const elements = {
  serverName: document.getElementById('serverName'),
  serverRail: document.querySelector('.server-rail'),
  emptyServerState: document.getElementById('emptyServerState'),
  textChannels: document.getElementById('textChannels'),
  voiceChannels: document.getElementById('voiceChannels'),
  roomTitle: document.getElementById('roomTitle'),
  roomDescription: document.getElementById('roomDescription'),
  messageList: document.getElementById('messageList'),
  messageArea: document.getElementById('messageArea'),
  welcomeCard: document.getElementById('welcomeCard'),
  chatForm: document.getElementById('chatForm'),
  messageInput: document.getElementById('messageInput'),
  searchDialog: document.getElementById('searchDialog'),
  createServerDialog: document.getElementById('createServerDialog'),
  createServerForm: document.getElementById('createServerForm'),
  createServerName: document.getElementById('createServerName'),
  createServerError: document.getElementById('createServerError'),
  submitCreateServer: document.getElementById('submitCreateServer'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  toast: document.getElementById('toast'),
  sidebar: document.querySelector('.sidebar'),
  authGate: document.getElementById('authGate'),
  authForm: document.getElementById('authForm'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authError: document.getElementById('authError'),
  authSubmit: document.getElementById('authSubmit'),
  authSwitch: document.getElementById('authSwitch')
};

const state = {
  user: null,
  servers: [],
  members: [],
  onlineIds: new Set(),
  currentServerId: '',
  currentChannelId: '',
  socket: null,
  ably: null,
  ablySyncPromise: null,
  ablyRefreshOnConnect: false,
  ablySubscriptions: new Map(),
  pendingInviteCode: new URLSearchParams(window.location.search).get('code') || '',
  registrationMode: false,
  firstAccountAvailable: false,
  toastTimer: null,
  channelGeneration: 0
};

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    throw new Error('Orbit cannot reach its server. Start the backend and try again.');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const contentType = response.headers.get('content-type') || 'unknown content type';
    throw new Error(`The server returned an invalid response (HTTP ${response.status}, ${contentType}). Check the Vercel API function and deployment logs.`);
  }
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      await signOut(false);
    }
    const error = new Error(payload.error || `The server returned an error (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('show'), 2800);
}

function setAuthMode(isRegistration) {
  state.registrationMode = isRegistration;
  document.getElementById('authTitle').textContent = isRegistration ? 'Make yourself at home.' : 'Good to have you back.';
  document.getElementById('authDescription').textContent = isRegistration
    ? state.firstAccountAvailable
      ? 'Create an account, then make a space for your friends.'
      : 'Create an account and use your friends’ invitation link to join.'
    : 'Sign in to pick up where your friends left off.';
  document.getElementById('authHint').textContent = isRegistration
    ? `Usernames use 2–24 letters, numbers, or underscores. Passwords need at least 10 characters. ${
        state.firstAccountAvailable
          ? 'After creating your account, create a space and invite your friends to join.'
          : 'New accounts need a valid friends’ invitation link.'
      }`
    : 'Use your account username and password.';
  elements.authPassword.autocomplete = isRegistration ? 'new-password' : 'current-password';
  elements.authPassword.value = '';
  elements.authError.hidden = true;
  elements.authSubmit.textContent = isRegistration ? 'Create account' : 'Sign in';
  elements.authSwitch.innerHTML = isRegistration
    ? 'Already have an account? <strong>Sign in</strong>'
    : 'New here? <strong>Create an account</strong>';
  elements.authGate.classList.toggle('registration-mode', isRegistration);
}

function showAuthError(error) {
  elements.authError.textContent = error.message;
  elements.authError.hidden = false;
}

async function authenticate(event) {
  event.preventDefault();
  elements.authSubmit.disabled = true;
  elements.authError.hidden = true;
  elements.authSubmit.textContent = state.registrationMode ? 'Creating account…' : 'Signing in…';
  try {
    const response = await api(state.registrationMode ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: elements.authUsername.value,
        password: elements.authPassword.value,
        invite: state.pendingInviteCode || undefined
      })
    });
    await startSession(response.user);
  } catch (error) {
    showAuthError(error);
  } finally {
    elements.authSubmit.disabled = false;
    elements.authSubmit.textContent = state.registrationMode ? 'Create account' : 'Sign in';
  }
}

async function startSession(user) {
  state.user = user;
  state.firstAccountAvailable = false;
  document.body.classList.remove('auth-required');
  elements.authGate.hidden = true;
  document.getElementById('currentUsername').textContent = user.username;
  document.getElementById('selfStatus').textContent = 'online';
  try {
    await acceptPendingInvite();
    const serverResponse = await api('/api/servers');
    state.servers = serverResponse.servers;
    const requestedServer = new URLSearchParams(window.location.search).get('invite');
    state.currentServerId = state.servers.some((server) => server.id === requestedServer)
      ? requestedServer
      : state.servers[0]?.id;
    const currentServer = getServer();
    state.currentChannelId = currentServer?.channels[0]?.id || '';
    await refreshMembers();
    await renderApp();
    connectRealtime();
    elements.messageInput.focus();
  } catch (error) {
    await signOut(false);
    elements.authGate.hidden = false;
    document.body.classList.add('auth-required');
    showAuthError(error);
  }
}

async function acceptPendingInvite() {
  if (!state.pendingInviteCode) return;
  try {
    const response = await api('/api/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ code: state.pendingInviteCode })
    });
    if (response.realtimeUnavailable) showToast('You joined, but friends may need to refresh to see the update.');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.pendingInviteCode = '';
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

async function restoreSession() {
  try {
    const response = await api('/api/auth/me');
    if (!response.user) {
      state.firstAccountAvailable = response.firstAccountAvailable === true;
      setAuthMode(state.registrationMode);
      document.body.classList.add('auth-required');
      elements.authGate.hidden = false;
      elements.authUsername.focus();
      return;
    }
    await startSession(response.user);
  } catch (error) {
    document.body.classList.add('auth-required');
    elements.authGate.hidden = false;
    elements.authUsername.focus();
    if (error.message !== 'Sign in to continue.') showAuthError(error);
  }
}

async function signOut(sendRequest = true) {
  state.socket?.disconnect();
  state.socket = null;
  state.ably?.close();
  state.ably = null;
  state.ablySyncPromise = null;
  state.ablyRefreshOnConnect = false;
  state.ablySubscriptions.clear();
  const hadUser = Boolean(state.user);
  state.user = null;
  state.servers = [];
  state.members = [];
  state.onlineIds.clear();
  document.body.classList.add('auth-required');
  elements.authGate.hidden = false;
  setAuthMode(false);
  if (sendRequest && hadUser) {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      showAuthError(error);
    }
  }
}

function getServer(serverId = state.currentServerId) {
  return state.servers.find((server) => server.id === serverId);
}

function getChannel(server = getServer(), channelId = state.currentChannelId) {
  return server?.channels.find((channel) => channel.id === channelId);
}

function appendTextElement(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderServerRail() {
  elements.serverRail.querySelectorAll('[data-server-index]').forEach((button) => button.remove());
  const addButton = document.getElementById('addServer');
  state.servers.forEach((server, index) => {
    const button = document.createElement('button');
    button.className = `server-icon${server.id === state.currentServerId ? ' selected' : ''}`;
    button.dataset.serverIndex = String(index);
    button.title = server.name;
    button.setAttribute('aria-label', server.name);
    button.textContent = server.icon || server.name.slice(0, 1).toUpperCase();
    elements.serverRail.insertBefore(button, addButton);
  });
}

function renderChannels() {
  const server = getServer();
  if (!server) {
    elements.serverName.textContent = 'No spaces yet';
    elements.textChannels.replaceChildren();
    elements.voiceChannels.replaceChildren();
    return;
  }
  elements.serverName.textContent = server.name;
  elements.textChannels.replaceChildren();
  server.channels.forEach((channel) => {
    const button = document.createElement('button');
    button.className = `channel${channel.id === state.currentChannelId ? ' active' : ''}`;
    button.dataset.channel = channel.id;
    const symbol = appendTextElement(button, 'span', 'channel-symbol', '#');
    symbol.setAttribute('aria-hidden', 'true');
    appendTextElement(button, 'span', 'channel-label', channel.name);
    elements.textChannels.append(button);
  });
  elements.voiceChannels.replaceChildren();
  server.voice.forEach((voiceRoom) => {
    const button = document.createElement('button');
    button.className = 'voice-channel';
    button.dataset.voice = voiceRoom.name;
    appendTextElement(button, 'span', 'voice-glyph', '◖');
    appendTextElement(button, 'span', 'channel-label', voiceRoom.name);
    elements.voiceChannels.append(button);
  });
}

function avatarClass(id) {
  return `avatar-user-${Math.abs(Number(id)) % 6}`;
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.messageId = String(message.id);
  const avatar = document.createElement('div');
  avatar.className = `avatar ${avatarClass(message.userId || 0)}`;
  avatar.textContent = message.author.slice(0, 1).toUpperCase();
  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = appendTextElement(meta, 'span', 'message-author', message.author);
  if (message.author === state.user?.username) author.classList.add('eli-author');
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt;
  time.textContent = new Date(`${message.createdAt.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  meta.append(time);
  appendTextElement(content, 'p', 'message-text', message.text);
  content.prepend(meta);
  article.append(avatar, content);
  return article;
}

function showEmptySearch(message) {
  elements.searchResults.replaceChildren();
  appendTextElement(elements.searchResults, 'p', 'search-empty', message);
}

async function loadRoom() {
  const server = getServer();
  const channel = getChannel(server);
  if (!server || !channel) {
    elements.messageList.replaceChildren();
    elements.welcomeCard.hidden = true;
    return;
  }
  const generation = ++state.channelGeneration;
  elements.roomTitle.textContent = channel.name;
  elements.roomDescription.textContent = channel.description || 'a cozy corner for the group';
  elements.messageInput.placeholder = `Message #${channel.name}`;
  elements.welcomeCard.hidden = channel.name !== 'general';
  elements.textChannels.querySelectorAll('.channel').forEach((button) => {
    button.classList.toggle('active', button.dataset.channel === channel.id);
  });
  elements.messageList.replaceChildren();
  try {
    const query = new URLSearchParams({ server: server.id, channel: channel.id });
    const response = await api(`/api/messages?${query}`);
    if (generation !== state.channelGeneration) return;
    elements.messageList.replaceChildren(...response.messages.map(renderMessage));
    elements.messageArea.scrollTop = elements.messageArea.scrollHeight;
    if (state.socket?.connected) {
      state.socket.emit('channel:join', { serverId: server.id, channelId: channel.id }, (result) => {
        if (result?.error) showToast(result.error);
      });
    }
  } catch (error) {
    if (generation === state.channelGeneration) showToast(error.message);
  }
}

function renderApp() {
  const hasServer = Boolean(getServer());
  document.body.classList.toggle('no-server-selected', !hasServer);
  elements.emptyServerState.hidden = hasServer;
  renderServerRail();
  renderChannels();
  renderMembers();
  document.getElementById('dateLabel').textContent = new Date().toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric'
  }).toUpperCase();
  return loadRoom();
}

function renderMembers() {
  const otherMembers = state.members.filter((member) => member.id !== state.user?.id);
  const online = otherMembers.filter((member) => state.onlineIds.has(member.id));
  const offline = otherMembers.filter((member) => !state.onlineIds.has(member.id));
  document.getElementById('friendsTotal').textContent = String(otherMembers.length);
  document.getElementById('onlineMembersCount').textContent = String(online.length);
  document.getElementById('offlineMembersCount').textContent = String(offline.length);
  document.getElementById('onlineCount').textContent = String(online.length + Number(state.onlineIds.has(state.user?.id)));
  renderMemberGroup('onlineMembers', online, false);
  renderMemberGroup('offlineMembers', offline, true);
}

function renderMemberGroup(containerId, members, isOffline) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  if (!members.length) {
    const empty = appendTextElement(container, 'p', 'member-empty', isOffline ? 'No other members yet.' : 'It’s quiet here — invite your friends!');
    return;
  }
  members.forEach((member) => {
    const row = document.createElement('div');
    row.className = `friend${isOffline ? ' friend-offline' : ''}`;
    row.title = `${member.username} is ${isOffline ? 'offline' : 'online'}`;
    const avatar = document.createElement('div');
    avatar.className = `avatar ${avatarClass(member.id)}`;
    avatar.textContent = member.username.slice(0, 1).toUpperCase();
    const presence = document.createElement('span');
    presence.className = 'presence-dot';
    avatar.append(presence);
    const info = document.createElement('div');
    info.className = 'friend-info';
    appendTextElement(info, 'strong', '', member.username);
    appendTextElement(info, 'span', '', isOffline ? 'offline' : 'here and hanging out');
    row.append(avatar, info);
    if (!isOffline) {
      const onlineDot = document.createElement('span');
      onlineDot.className = 'friend-status';
      row.append(onlineDot);
    }
    container.append(row);
  });
}

function loadSocketClient() {
  if (typeof window.io === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('The local chat service is unavailable.'));
    document.head.append(script);
  });
}

async function connectSocket() {
  try {
    await loadSocketClient();
  } catch (error) {
    showToast(error.message);
    return;
  }
  state.socket?.disconnect();
  const socket = window.io({ reconnection: true, reconnectionDelayMax: 5000 });
  state.socket = socket;
  socket.on('connect', () => {
    const server = getServer();
    if (server) socket.emit('channel:join', { serverId: server.id, channelId: state.currentChannelId });
  });
  socket.on('connect_error', () => showToast('Live chat disconnected. Trying to reconnect…'));
  socket.on('presence:update', (userIds) => {
    state.onlineIds = new Set(userIds);
    renderMembers();
  });
  socket.on('server:updated', refreshServerList);
  socket.on('chat:message', (message) => {
    if (message.id === undefined) return;
    const alreadyRendered = elements.messageList.querySelector(`[data-message-id="${Number(message.id)}"]`);
    if (alreadyRendered) return;
    renderRealtimeMessage(message);
  });
}

function renderRealtimeMessage(message) {
  if (!state.currentServerId || !state.currentChannelId) return;
  if (message.serverId !== state.currentServerId || message.channelId !== state.currentChannelId) return;
  const alreadyRendered = elements.messageList.querySelector(`[data-message-id="${Number(message.id)}"]`);
  if (alreadyRendered) return;
  const nearBottom = elements.messageArea.scrollHeight - elements.messageArea.scrollTop - elements.messageArea.clientHeight < 100;
  elements.messageList.append(renderMessage(message));
  if (nearBottom) elements.messageArea.scrollTop = elements.messageArea.scrollHeight;
}

async function refreshServerList() {
  try {
    const response = await api('/api/servers');
    state.servers = response.servers;
    if (!getServer() || !getChannel()) {
      state.currentServerId = state.servers[0]?.id || '';
      state.currentChannelId = getServer()?.channels[0]?.id || '';
    }
    renderServerRail();
    renderChannels();
    await loadRoom();
    if (state.ably) await syncAblyMemberships(true);
  } catch (error) {
    showToast(error.message);
  }
}

async function connectRealtime() {
  let initialTokenRequest;
  try {
    ({ tokenRequest: initialTokenRequest } = await api('/api/realtime/token', {
      method: 'POST',
      body: JSON.stringify({})
    }));
  } catch (error) {
    if (error.status === 404) return connectSocket();
    showToast(`Live chat could not connect: ${error.message}`);
    return;
  }
  if (typeof window.Ably?.Realtime !== 'function') {
    showToast('The realtime client did not load. Check your connection and refresh the page.');
    return;
  }

  let cachedTokenRequest = initialTokenRequest;
  state.ably = new window.Ably.Realtime({
    authCallback: (tokenParams, callback) => {
      if (cachedTokenRequest) {
        const request = cachedTokenRequest;
        cachedTokenRequest = null;
        callback(null, request);
        return;
      }
      api('/api/realtime/token', { method: 'POST', body: JSON.stringify({}) })
        .then(({ tokenRequest }) => callback(null, tokenRequest))
        .catch((error) => callback(error, null));
    },
    autoConnect: true
  });
  state.ably.connection.on('failed', (change) => showToast(`Live chat disconnected: ${change.reason?.message || 'connection failed'}`));
  state.ably.connection.on('connected', () => {
    const refreshToken = state.ablyRefreshOnConnect;
    state.ablyRefreshOnConnect = false;
    syncAblyMemberships(refreshToken).catch((error) => showToast(error.message));
  });
}

async function syncAblyMemberships(refreshToken = false) {
  const client = state.ably;
  if (!client) return;
  if (client.connection.state !== 'connected') {
    if (refreshToken) state.ablyRefreshOnConnect = true;
    return;
  }
  if (state.ablySyncPromise) {
    await state.ablySyncPromise;
    if (refreshToken) return syncAblyMemberships(true);
    return;
  }
  state.ablySyncPromise = (async () => {
    if (refreshToken) await client.auth.authorize();
    const activeServerIds = new Set(state.servers.map((server) => server.id));
    for (const [serverId, channels] of state.ablySubscriptions) {
      if (activeServerIds.has(serverId)) continue;
      channels.events.unsubscribe();
      channels.presence.presence.unsubscribe();
      await channels.presence.presence.leave().catch((error) => console.error('Could not leave Ably presence:', error));
      state.ablySubscriptions.delete(serverId);
    }
    for (const server of state.servers) {
      if (state.ablySubscriptions.has(server.id)) continue;
      const events = client.channels.get(`orbit:server:${server.id}`);
      const presence = client.channels.get(`orbit:server:${server.id}:presence`);
      state.ablySubscriptions.set(server.id, { events, presence });
      try {
        await events.subscribe((event) => {
          if (event.name === 'chat:message') renderRealtimeMessage(event.data);
          if (event.name === 'server:updated') refreshServerList();
        });
        await presence.presence.subscribe(['enter', 'leave', 'update'], () => {
          if (state.currentServerId === server.id) refreshMembers();
        });
        await presence.presence.enter({ username: state.user.username });
      } catch (error) {
        events.unsubscribe();
        presence.presence.unsubscribe();
        state.ablySubscriptions.delete(server.id);
        throw error;
      }
    }
    if (state.currentServerId) await refreshMembers();
  })();
  try {
    await state.ablySyncPromise;
  } finally {
    state.ablySyncPromise = null;
  }
}

async function refreshMembers() {
  if (!state.currentServerId) {
    state.members = [];
    state.onlineIds.clear();
    renderMembers();
    return;
  }
  try {
    const query = new URLSearchParams({ server: state.currentServerId });
    const response = await api(`/api/members?${query}`);
    state.members = response.members;
    state.onlineIds = new Set(response.members.filter((member) => member.online).map((member) => member.id));
    renderMembers();
  } catch (error) {
    showToast(error.message);
  }
}

async function inviteFriends() {
  const invite = new URL(window.location.href);
  invite.searchParams.set('invite', state.currentServerId);
  invite.searchParams.delete('code');
  try {
    const response = await api(`/api/servers/${encodeURIComponent(state.currentServerId)}/invites`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    invite.searchParams.set('code', response.code);
    const inviteLink = invite.toString();
    try {
      await navigator.clipboard.writeText(inviteLink);
      showToast('Invite link copied — share it with your friends!');
    } catch (error) {
      console.error('Could not copy the invite link:', error);
      const copied = window.prompt('Copy this private invitation link:', inviteLink);
      showToast(copied === null ? 'Invite created. Try again to get a new shareable link.' : 'Your invitation link is ready to share.');
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function addTextChannel() {
  const entry = window.prompt('What should this channel be called?');
  if (entry === null) return;
  try {
    const response = await api(`/api/servers/${encodeURIComponent(state.currentServerId)}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name: entry })
    });
    const server = getServer();
    if (!server.channels.some((channel) => channel.id === response.channel.id)) {
      server.channels.push(response.channel);
    }
    state.currentChannelId = response.channel.id;
    renderApp();
    if (response.realtimeUnavailable) showToast('Channel created, but friends may need to refresh to see it.');
    elements.messageInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function addVoiceChannel() {
  const entry = window.prompt('What should this voice room be called?');
  if (entry === null) return;
  try {
    const result = await api(`/api/servers/${encodeURIComponent(state.currentServerId)}/voice`, {
      method: 'POST',
      body: JSON.stringify({ name: entry })
    });
    const response = await api('/api/servers');
    state.servers = response.servers;
    renderServerRail();
    renderChannels();
    if (result.realtimeUnavailable) showToast('Voice room created, but friends may need to refresh to see it.');
  } catch (error) {
    showToast(error.message);
  }
}

function addServer() {
  elements.createServerName.value = '';
  elements.createServerError.hidden = true;
  elements.createServerError.textContent = '';
  elements.createServerDialog.showModal();
  elements.createServerName.focus();
}

async function createServer(event) {
  event.preventDefault();
  elements.submitCreateServer.disabled = true;
  elements.createServerError.hidden = true;
  try {
    const response = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: elements.createServerName.value })
    });
    if (!getServer(response.server.id)) state.servers.push(response.server);
    state.currentServerId = response.server.id;
    state.currentChannelId = 'general';
    elements.createServerDialog.close();
    renderApp();
    if (response.realtimeUnavailable) showToast('Space created, but friends may need to refresh to see it.');
    if (state.ably) await syncAblyMemberships(true).catch((error) => showToast(`Space created, but live chat could not refresh: ${error.message}`));
  } catch (error) {
    elements.createServerError.textContent = error.message;
    elements.createServerError.hidden = false;
  } finally {
    elements.submitCreateServer.disabled = false;
  }
}

async function submitMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text) return;
  const submitButton = elements.chatForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        serverId: state.currentServerId,
        channelId: state.currentChannelId,
        text
      })
    });
    if (response.realtimeUnavailable) showToast('Message saved, but live delivery failed. Refresh to see the latest messages.');
    if (response.realtimeUnavailable || (!state.socket?.connected && state.ably?.connection.state !== 'connected')) {
      elements.messageList.append(renderMessage(response.message));
      elements.messageArea.scrollTop = elements.messageArea.scrollHeight;
    }
    elements.messageInput.value = '';
    elements.messageInput.focus();
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
}

function renderSearchResults(results, query) {
  elements.searchResults.replaceChildren();
  if (!results.length) {
    showEmptySearch(query ? 'No messages found. Try a different word.' : 'Search across your chats to find a message.');
    return;
  }
  results.forEach((result) => {
    const button = document.createElement('button');
    button.className = 'search-result';
    button.type = 'button';
    const meta = document.createElement('div');
    meta.className = 'search-result-meta';
    appendTextElement(meta, 'strong', '', result.author);
    appendTextElement(meta, 'span', '', `${result.serverName} · #${result.channelName} · ${result.createdAt}`);
    const text = document.createElement('div');
    text.className = 'search-result-text';
    text.textContent = result.text;
    button.append(meta, text);
    button.addEventListener('click', async () => {
      state.currentServerId = result.serverId;
      state.currentChannelId = result.channelId;
      elements.searchDialog.close();
      await renderApp();
      document.querySelector(`[data-message-id="${Number(result.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    elements.searchResults.append(button);
  });
}

async function searchMessages(query) {
  const trimmed = query.trim();
  if (!trimmed) return showEmptySearch('Search across your chats to find a message.');
  if (trimmed.length > 80) return showEmptySearch('Search is limited to 80 characters.');
  try {
    const params = new URLSearchParams({ q: trimmed });
    const response = await api(`/api/search?${params}`);
    renderSearchResults(response.results, trimmed);
  } catch (error) {
    showEmptySearch(error.message);
  }
}

async function openSearch() {
  elements.searchDialog.showModal();
  elements.searchInput.value = '';
  showEmptySearch('');
  elements.searchInput.focus();
}

function openSelectedServerMenu() {
  if (!state.servers.length) return showToast('Create a space first.');
  const choices = state.servers.map((server, index) => `${index + 1}. ${server.name}`).join('\n');
  const selection = window.prompt(`Choose a space by number:\n${choices}`, '1');
  if (selection === null) return;
  const server = state.servers[Number.parseInt(selection, 10) - 1];
  if (!server) return showToast('That space number does not exist.');
  state.currentServerId = server.id;
  state.currentChannelId = server.channels[0]?.id || '';
  renderApp();
}

function leaveVoiceRoom() {
  showToast('Voice rooms are listed here; voice calling is not set up yet.');
}

elements.authForm.addEventListener('submit', authenticate);
elements.authSwitch.addEventListener('click', () => setAuthMode(!state.registrationMode));
document.getElementById('logoutButton').addEventListener('click', () => signOut(true));
elements.chatForm.addEventListener('submit', submitMessage);
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});
elements.textChannels.addEventListener('click', (event) => {
  const button = event.target.closest('[data-channel]');
  if (!button) return;
  state.currentChannelId = button.dataset.channel;
  renderChannels();
  loadRoom();
  elements.sidebar.classList.remove('mobile-open');
});
elements.voiceChannels.addEventListener('click', leaveVoiceRoom);
elements.serverRail.addEventListener('click', (event) => {
  const button = event.target.closest('[data-server-index]');
  if (!button) return;
  const server = state.servers[Number(button.dataset.serverIndex)];
  if (!server) return;
  state.currentServerId = server.id;
  state.currentChannelId = server.channels[0]?.id || '';
  renderServerRail();
  renderChannels();
  refreshMembers();
  loadRoom();
});
document.querySelectorAll('[data-add-channel]').forEach((button) => button.addEventListener('click', addTextChannel));
document.querySelectorAll('[data-add-voice]').forEach((button) => button.addEventListener('click', addVoiceChannel));
document.getElementById('addServer').addEventListener('click', addServer);
document.getElementById('createFirstServer').addEventListener('click', addServer);
elements.createServerForm.addEventListener('submit', createServer);
document.getElementById('closeCreateServer').addEventListener('click', () => elements.createServerDialog.close());
document.getElementById('cancelCreateServer').addEventListener('click', () => elements.createServerDialog.close());
elements.createServerDialog.addEventListener('click', (event) => {
  if (event.target === elements.createServerDialog) elements.createServerDialog.close();
});
document.getElementById('inviteButton').addEventListener('click', inviteFriends);
document.getElementById('inviteSmall').addEventListener('click', inviteFriends);
document.getElementById('welcomeInvite').addEventListener('click', inviteFriends);
document.getElementById('searchButton').addEventListener('click', openSearch);
elements.searchInput.addEventListener('input', (event) => {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => searchMessages(event.target.value), 180);
});
document.querySelector('.close-search').addEventListener('click', () => elements.searchDialog.close());
document.getElementById('mobileMenu').addEventListener('click', () => elements.sidebar.classList.toggle('mobile-open'));
elements.messageArea.addEventListener('click', () => elements.sidebar.classList.remove('mobile-open'));
document.getElementById('serverMenu').addEventListener('click', openSelectedServerMenu);
document.getElementById('emojiButton').addEventListener('click', () => {
  elements.messageInput.value += ' 🙂';
  elements.messageInput.focus();
});
document.getElementById('attachButton').addEventListener('click', () => {
  elements.messageInput.value += ' ✨';
  elements.messageInput.focus();
});
document.getElementById('searchForm').addEventListener('submit', (event) => event.preventDefault());
elements.searchDialog.addEventListener('click', (event) => {
  if (event.target === elements.searchDialog) elements.searchDialog.close();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.user) openSearch();
  }
  if (event.key === 'Escape') elements.sidebar.classList.remove('mobile-open');
});
document.getElementById('addServer').title = 'Create a shared server';
window.setInterval(() => {
  if (state.user) refreshMembers();
}, 15_000);

setAuthMode(false);
restoreSession();
