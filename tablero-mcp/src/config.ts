// Public identifiers of the hosted tablero. They are not secrets: the same values ship in the web app's JavaScript.
// Access is decided by the Firestore rules and by who signs in, never by these.
export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface Config {
  firebase: FirebaseWebConfig
  oauth: OAuthClient
  /** Where people create and manage their boards. */
  webUrl: string
}

export const HOSTED_FIREBASE: FirebaseWebConfig = {
  apiKey: 'AIzaSyCBF5lPpQejT9b7DEXBHBM9k_8gzowB6Bo',
  authDomain: 'daniel-moros.firebaseapp.com',
  projectId: 'daniel-moros',
  appId: '1:673356955197:web:c165d9cd694f29391e3454',
}

// Google OAuth client of type "Desktop app" created in the project's Google Cloud console. Google documents that the
// secret of an installed-app client is not confidential, so it can ship in the package. Fill these in after creating
// the client (see docs/puesta-en-marcha.md); an empty value makes `setup` explain what is missing.
export const HOSTED_OAUTH: OAuthClient = {
  clientId: '673356955197-651od6rfhqojbaafskajtaj3cqj5np9e.apps.googleusercontent.com',
  clientSecret: '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',
}

export const HOSTED_WEB_URL = 'https://tablero-moros.web.app'

/** The hosted instance by default; every value can be overridden so someone can point it at their own Firebase project. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    firebase: {
      apiKey: env.TABLERO_FIREBASE_API_KEY ?? HOSTED_FIREBASE.apiKey,
      authDomain: env.TABLERO_FIREBASE_AUTH_DOMAIN ?? HOSTED_FIREBASE.authDomain,
      projectId: env.TABLERO_FIREBASE_PROJECT_ID ?? HOSTED_FIREBASE.projectId,
      appId: env.TABLERO_FIREBASE_APP_ID ?? HOSTED_FIREBASE.appId,
    },
    oauth: {
      clientId: env.TABLERO_OAUTH_CLIENT_ID ?? HOSTED_OAUTH.clientId,
      clientSecret: env.TABLERO_OAUTH_CLIENT_SECRET ?? HOSTED_OAUTH.clientSecret,
    },
    webUrl: env.TABLERO_WEB_URL ?? HOSTED_WEB_URL,
  }
}
