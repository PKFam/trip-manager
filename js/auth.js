// auth.js — the login gate. Nothing in app.js runs until this resolves to
// a signed-in, allowed user. Real enforcement is server-side (RLS); this is
// the UI layer that shows/hides the login screen and derives "who am I".

// Keep in sync with the two emails in supabase/schema.sql.
const PEOPLE = {
  'gilpeeri.eon@gmail.com': 'Gil',
  'tamikoza@gmail.com': 'Tammy',
};

const Auth = {
  user: null, // { email, who }

  whoFor(email) {
    return PEOPLE[email] || (email || '').split('@')[0];
  },

  async signIn() {
    await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
  },

  async signOut() {
    await sb.auth.signOut();
    location.reload();
  },

  showLogin(message) {
    $('#app').hidden = true;
    $('.nav').hidden = true;
    $('#authGate').hidden = false;
    $('#authError').textContent = message || '';
    $('#authError').hidden = !message;
  },

  showApp() {
    $('#authGate').hidden = true;
    $('#app').hidden = false;
    $('.nav').hidden = false;
  },

  // Resolves once we know whether to show the app or the login screen.
  // Runs main() (passed in) only for an allowed, signed-in user.
  async init(onReady) {
    $('#authSignInBtn').onclick = () => this.signIn();

    const { data: { session } } = await sb.auth.getSession();
    await this.handleSession(session, onReady);

    sb.auth.onAuthStateChange((_event, session) => {
      // CRITICAL: never run supabase queries directly inside this callback.
      // supabase-js holds an internal auth lock while it fires, and any query
      // that needs the token deadlocks forever (app boots to a dead skeleton).
      // Deferring to the next tick releases the lock first.
      setTimeout(() => this.handleSession(session, onReady), 0);
    });
  },

  async handleSession(session, onReady) {
    const email = session?.user?.email;
    if (!email) { this.showLogin(); return; }

    if (!PEOPLE[email]) {
      this.showLogin(`${email} isn't invited to this trip. Sign in with the right Google account.`);
      await sb.auth.signOut();
      return;
    }

    const already = this.user?.email === email;
    this.user = { email, who: this.whoFor(email) };
    this.showApp();
    if (!already) onReady(); // only (re)boot the app on an actual sign-in, not every token refresh
  },
};

window.Auth = Auth;
