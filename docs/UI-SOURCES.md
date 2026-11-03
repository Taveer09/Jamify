# 21st.dev integration — 2026-11-03

User explicitly requested the21st-ui skill and21st.dev MCP. Used connected MCP get_usage/search/get_component, not hosted AI generation. Retrieved two components within the free daily allowance; no purchase, subscription or paid generation.

- Origin UI Button / Loading button, demo146: https://21st.dev/@originui/components/button
  Native adaptation in src/components/ui/Button.tsx: semantic button props, focus, disabled state, unchanged label width and centered spinner. Integrated into welcome/library/demo/review/confirmation controls. Tailwind/Slot/CVA were translated into existing CSS; no dependency migration. No artificial1000ms success timer from the example.
- Delta Components MP3 Player, demo31602: https://21st.dev/@deltacomponents/components/mp3-player
  Inline play/time/scrub/time composition and focus/hover scrubber affordances adapted in src/components/PlaybackTransport.tsx and src/styles/polish.css. Existing Spotify SDK and demo gateway remain the authority; catalog HTMLAudio/media-session/speed/download/remote sample audio are not integrated. No fabricated waveform.

The catalog code is adapted, not an unchanged drop-in. Existing Onest, Spotify palette, card gesture and background identity retained. No secret/API key in registry URLs, source, git or reports. No other catalog retrievals claimed. Technical S0 diagnostics retain their functional layout; public welcome, library, chooser, review and result use the refreshed shared system.
