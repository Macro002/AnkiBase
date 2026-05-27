import React from 'react'
import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '1.1rem' }}>
      <img src="/AnkiBase/logo.svg" alt="" width={24} height={24} />
      AnkiBase
    </span>
  ),
  project: {
    link: 'https://github.com/Macro002/AnkiBase',
  },
  docsRepositoryBase: 'https://github.com/Macro002/AnkiBase/blob/main/docs',
  useNextSeoProps() {
    return { titleTemplate: '%s – AnkiBase' }
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="description" content="Self-hosted web interface for Anki — study, sync, import, and generate AI stories." />
      <link rel="icon" href="/AnkiBase/logo.svg" type="image/svg+xml" />
    </>
  ),
  primaryHue: 350,
  primarySaturation: 79,
  footer: {
    text: (
      <span>
        MIT {new Date().getFullYear()} ©{' '}
        <a href="https://github.com/Macro002/AnkiBase" target="_blank" rel="noreferrer">
          AnkiBase
        </a>
      </span>
    ),
  },
  sidebar: {
    titleComponent({ title, type }) {
      return <>{title}</>
    },
  },
}

export default config
