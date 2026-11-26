/**
 * eslint.config.js — 只抓「会让页面静默出错」的问题。
 *
 * 为什么这样配：这个项目已经连续几次踩同一类坑——
 *   `config is not defined`、`metricTile is not defined`、`renderBasisToggle is not defined`。
 * 这些都不是风格问题，是**运行时才会炸**的错误，而且往往是在我手工 e2e 时才发现的。
 *
 * 所以这里不开任何格式规则（缩进、分号、引号一律不管），只开：
 *   no-undef           用了不存在的变量
 *   no-unused-vars     声明了没用（往往意味着改名改漏了）
 *   no-dupe-keys       对象里重复的键（复制粘贴常见）
 *   no-unreachable     永远不会执行的代码
 *   no-self-assign     自己赋值给自己
 *   no-const-assign    改 const
 *
 * 浏览器全局要显式声明，否则 no-undef 会把 window/mdui 这些全报成错误。
 */

export default [
  {
    ignores: [
      "vendor/**",
      "node_modules/**",
      "data/**",
      "docs/**",
    ],
  },
  {
    files: ["js/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        // 浏览器
        window: "readonly",
        document: "readonly",
        location: "readonly",
        history: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        performance: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Blob: "readonly",
        File: "readonly",
        FileReader: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        queueMicrotask: "readonly",
        Image: "readonly",
        BlobEvent: "readonly",
        DOMParser: "readonly",
        XMLSerializer: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        Node: "readonly",
        getComputedStyle: "readonly",
        matchMedia: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
        // MDUI 暴露为全局
        mdui: "readonly",
        // Node（测试文件里会用到）
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-const-assign": "error",
      "no-func-assign": "error",
      "no-obj-calls": "error",
      "valid-typeof": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unsafe-negation": "error",
      "no-cond-assign": ["error", "except-parens"],
    },
  },
];