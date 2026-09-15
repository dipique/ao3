declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BROWSER: 'chrome' | 'firefox'
      NODE_ENV: 'development' | 'production'
      /** The builder run that produced this bundle (see scripts/builder/common.ts). */
      BUILD_ID: string
    }
  }
}

export {}
