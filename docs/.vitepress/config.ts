import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: 'Vigilo WASM',
    description:
      'In-browser exam proctoring: YuNet, head pose, gaze, prohibited objects and temporal fusion in WebAssembly & WebGPU.',
    base: '/vigilo-wasm/',
    lastUpdated: true,
    ignoreDeadLinks: false,
    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/vigilo-wasm/logo.svg' }],
      ['meta', { name: 'theme-color', content: '#f59e0b' }],
      ['meta', { property: 'og:title', content: 'Vigilo WASM Documentation' }],
      [
        'meta',
        {
          property: 'og:description',
          content:
            'In-browser exam proctoring: YuNet, head pose, gaze, prohibited objects and temporal fusion in WebAssembly & WebGPU.',
        },
      ],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:url', content: 'https://abdullah-masood-05.github.io/vigilo-wasm/' }],
      // Absolute URL: crawlers resolve og:image against their own origin, not the page.
      [
        'meta',
        {
          property: 'og:image',
          content: 'https://abdullah-masood-05.github.io/vigilo-wasm/og-image.png',
        },
      ],
      ['meta', { property: 'og:image:width', content: '2400' }],
      ['meta', { property: 'og:image:height', content: '1260' }],
      [
        'meta',
        {
          property: 'og:image:alt',
          content: 'Vigilo WASM documentation: in-browser AI exam proctoring',
        },
      ],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      [
        'meta',
        {
          name: 'twitter:image',
          content: 'https://abdullah-masood-05.github.io/vigilo-wasm/og-image.png',
        },
      ],
    ],
    appearance: 'dark',
    themeConfig: {
      logo: '/logo.svg',
      darkModeSwitchLabel: 'Appearance',
      lightModeSwitchTitle: 'Switch to light theme',
      darkModeSwitchTitle: 'Switch to dark theme',
      nav: [
        { text: 'Guide', link: '/guide/what-is-vigilo-wasm' },
        { text: 'API Reference', link: '/api/vigilo-browser' },
        { text: 'Architecture', link: '/architecture/overview' },
        { text: 'Benchmarks', link: '/benchmarks/performance' },
        {
          text: 'Packages',
          items: [
            { text: 'vigilo-wasm (CPU v1.0.2)', link: 'https://www.npmjs.com/package/vigilo-wasm' },
            { text: 'vigilo-wasm-gpu (WebGPU v1.0.0)', link: 'https://www.npmjs.com/package/vigilo-wasm-gpu' },
            {
              text: 'GitHub Releases',
              link: 'https://github.com/Abdullah-Masood-05/vigilo-wasm/releases',
            },
            {
              text: 'vigilo-stream (Python)',
              link: 'https://abdullah-masood-05.github.io/vigilo-stream/',
            },
          ],
        },
      ],
      sidebar: {
        '/guide/': [
          {
            text: 'Getting Started',
            items: [
              { text: 'What is vigilo-wasm?', link: '/guide/what-is-vigilo-wasm' },
              { text: 'Installation & Quickstart', link: '/guide/getting-started' },
            ],
          },
          {
            text: 'Browser Runtime',
            items: [
              { text: 'VigiloBrowser & Scheduler', link: '/guide/browser-runtime' },
              { text: 'Camera & Canvas Capture', link: '/guide/camera-canvas' },
              { text: 'Model Loading & Caching', link: '/guide/models-caching' },
            ],
          },
          {
            text: 'Engine & Replay',
            items: [
              { text: 'Temporal Fusion & Replay', link: '/guide/fusion-replay' },
            ],
          },
        ],
        '/api/': [
          {
            text: 'High-Level Browser API',
            items: [
              { text: 'VigiloBrowser', link: '/api/vigilo-browser' },
              { text: 'CameraSource', link: '/api/camera-source' },
              { text: 'Model Management', link: '/api/load-models' },
            ],
          },
          {
            text: 'Core Engine API',
            items: [
              { text: 'ProctorSession & Replay', link: '/api/proctor-session' },
              { text: 'VigiloPipeline (Lower-level)', link: '/api/pipeline' },
              { text: 'Signals & Detection Types', link: '/api/types-signals' },
              { text: 'Violations & Events', link: '/api/events-violations' },
              { text: 'Configuration Schema', link: '/api/config' },
            ],
          },
        ],
        '/architecture/': [
          {
            text: 'Architecture',
            items: [
              { text: 'System Overview', link: '/architecture/overview' },
            ],
          },
        ],
        '/benchmarks/': [
          {
            text: 'Benchmarks',
            items: [
              { text: 'Performance & WebGPU', link: '/benchmarks/performance' },
            ],
          },
        ],
      },
      socialLinks: [
        { icon: 'github', link: 'https://github.com/Abdullah-Masood-05/vigilo-wasm' },
        { icon: 'npm', link: 'https://www.npmjs.com/package/vigilo-wasm' },
      ],
      footer: {
        message: 'Released under the AGPL-3.0 License.',
        copyright: 'Copyright © 2026 Abdullah Masood',
      },
      search: { provider: 'local' },
    },
    mermaid: {
      theme: 'base',
      // SVG <text> labels instead of HTML in <foreignObject>: mermaid then measures
      // the text it actually renders, so nothing wraps out of its box or gets clipped
      // by the surrounding VitePress typography. This has to be the top-level key --
      // mermaid 11 reads `config.htmlLabels ?? config.flowchart.htmlLabels ?? true`,
      // so the (deprecated) flowchart one never wins against the default.
      htmlLabels: false,
      flowchart: {
        padding: 14,
        nodeSpacing: 45,
        rankSpacing: 60,
        subGraphTitleMargin: { top: 6, bottom: 14 },
        useMaxWidth: true,
      },
      themeVariables: {
        darkMode: true,
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        background: '#0f1117',
        primaryColor: '#1a1e29',
        primaryBorderColor: '#363d4f',
        primaryTextColor: '#f3f4f6',
        secondaryColor: '#242a38',
        tertiaryColor: '#12151e',
        lineColor: '#9ca3af',
        textColor: '#d1d5db',
        nodeTextColor: '#f3f4f6',
        titleColor: '#f3f4f6',
        clusterBkg: '#12151e',
        clusterBorder: '#2d3444',
        edgeLabelBackground: '#1a1e29',
        nodeBorder: '#f59e0b',
        mainBkg: '#1a1e29',
      },
    },
  })
);
