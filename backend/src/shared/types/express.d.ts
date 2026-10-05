import type { AuthContext } from './auth-context.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authentication guard; absent on unauthenticated routes. */
      auth?: AuthContext;
    }
  }
}
