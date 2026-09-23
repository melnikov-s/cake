// Cross-subgraph routes and long labels exercise the converter's own layout, not Cake's flow layout.
export const drawMermaidArchitecture = `flowchart TB
  subgraph renderer["Sandboxed Renderer"]
    models["Renderer Models + Stores with measured labels"]
    chat["Shared Chat and Conversation surfaces"]
    canvas["Draw canvas and native elements"]
    models --> chat
    chat --> canvas
  end
  subgraph main["Electron Main"]
    services["Cake services and durable board storage"]
    pi["Pi Runtime agent loop + transcript"]
    coordinator["Renderer request coordinator"]
    services --> pi
    coordinator --> services
  end
  subgraph external["External Systems"]
    provider["Model provider"]
    filesystem["Workspace filesystem"]
  end
  models -->|typed RPC| services
  chat --> coordinator
  canvas -->|save board| services
  pi --> provider
  services --> filesystem
  filesystem -->|source changes| models`;
