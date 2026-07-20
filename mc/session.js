const TOKEN_KEY = 'mc_session_token';
const ROLE_KEY = 'mc_session_role';

export function token() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function role() {
  return sessionStorage.getItem(ROLE_KEY) || '';
}

export function setSession(t, r) {
  sessionStorage.setItem(TOKEN_KEY, t);
  sessionStorage.setItem(ROLE_KEY, r);
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ROLE_KEY);
}

export function agentActor() {
  return role() === 'alan' ? 'alan' : 'cursor';
}
