import type { PrototypeSource } from "../../src/contracts/widgets/prototype-source";

export const encodePrototype = (bundle: PrototypeSource) =>
  `export default ${JSON.stringify(bundle)};`;

export function prototypeFixture() {
  const ids = [1, 2, 3, 4, 5].map((n) => `option-${n}`);
  return {
    schema: "cake.prototype-source/v1" as const,
    chooser: {
      id: "chooser",
      dependencies: ["react", "@cake/artifact-sdk", ...ids.map((id) => `cake:prototype/${id}`)],
      source: [
        'import {useState} from "react";',
        'import {useArtifactState} from "@cake/artifact-sdk";',
        ...ids.map((id, index) => `import Option${index} from "cake:prototype/${id}";`),
        `const options = [${ids.map((id, index) => `{id:"${id}", Component:Option${index}}`).join(",")}];`,
        "export default function Chooser(){",
        'const {value,hydrated,save}=useArtifactState({schema:"cake.prototype-ui/v1",selectedOptionId:null});',
        'const [active,setActive]=useState("option-1");',
        'const [error,setError]=useState(""); const [pending,setPending]=useState(false);',
        "const option=options.find(o=>o.id===active); const Component=option.Component;",
        "return <div><nav>{options.map(o=><button key={o.id} onClick={()=>setActive(o.id)}>{o.id}</button>)}</nav>",
        '<Component/><p>Saved: {value.selectedOptionId ?? "none"}</p>',
        '<button disabled={!hydrated||pending} onClick={async()=>{setPending(true);setError("");try{await save({...value,selectedOptionId:option.id});}catch(e){setError(String(e));}finally{setPending(false);}}}>Choose this</button>',
        '<p role="alert">{error}</p></div>;',
        "}",
      ].join("\n"),
    },
    options: ids.map((id) => ({
      id,
      dependencies: ["cake:prototype/palette"],
      source: `import {palette} from "cake:prototype/palette"; export default function Option(){return <section style={{color:palette.ink}}>${id} design</section>;}`,
    })),
    shared: [
      {
        id: "palette",
        dependencies: ["cake:prototype/tokens"],
        source: 'import {ink} from "cake:prototype/tokens"; export const palette={ink};',
      },
      { id: "tokens", dependencies: [], source: 'export const ink="#123456";' },
      { id: "unused", dependencies: [], source: 'export const unused="not required";' },
    ],
  } satisfies PrototypeSource;
}
