/** Mermaid source transcribed from the reported stuck-diagram screenshot. */
export const godotDiagram = `flowchart TB
    Player["Player"] --> UI["Godot presentation<br/>Movement, dialogue, scenes"]

    subgraph Game["Godot game"]
        UI --> Commands["Commands<br/>Move, talk, trade, attack"]
        Commands --> Core["Deterministic core<br/>Validate and execute"]
        Core --> State["Authoritative world state"]
        Core --> Events["Committed events"]
        State --> UI

        Context["Context builder<br/>Relevant facts and permitted knowledge"]
        State --> Context
    end

    subgraph Creative["AI coordinator — separate service"]
        Director["Bounded generation jobs"]
        Dialogue["Dialogue and NPC intentions"]
        Worldgen["Characters, locations, quests"]
        Art["Image / optional 3D generation"]
        Director --> Dialogue
        Director --> Worldgen
        Director --> Art
    end

    Context --> Director
    Director --> Proposals["Structured proposals"]
    Proposals --> Core

    subgraph Persistence["Local world save"]
        Saves["State snapshots + event journal"]
        Memories["Markdown memories"]
        Assets["Approved asset cache"]
    end

    Events --> Saves
    Events --> Memory["Memory writer"]
    Memory --> Memories
    Memories --> Context
    Art --> Assets`;
