/// <reference types="vite/client" />

interface ImportMetaEnv {
   readonly VICMET_BASE: string
}

interface ImportMeta {
   readonly env: ImportMetaEnv
}
