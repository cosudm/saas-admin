/* Schema importers: OpenAPI 3.x / Swagger 2.0 (JSON+YAML), GraphQL (SDL + introspection),
   WSDL (SOAP), gRPC .proto — normalized into typed MCP tool definitions.
   Direct port of the Python reference implementation. */
import YAML from "yaml";

const MAX_TOOL_NAME = 60;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_RE = /student|transcript|patient|ssn|record|grade|hold|payroll|salary|credential|secret|token|password/i;

export function slugify(s) {
  return (String(s || "api").trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()) || "api";
}
function toolname(raw) {
  const n = String(raw).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return n.slice(0, MAX_TOOL_NAME) || "op";
}
function governance(method, text) {
  const m = String(method).toUpperCase();
  const write = WRITE_METHODS.has(m) || m === "MUTATION";
  const sensitive = SENSITIVE_RE.test(text || "");
  if (write) return sensitive ? "Guardrail + attestation" : "Guardrail";
  return "Read · identity-scoped";
}
function annotations(method) {
  const m = String(method).toUpperCase();
  const read = ["GET", "QUERY"].includes(m);
  return {
    readOnlyHint: read,
    destructiveHint: m === "DELETE",
    idempotentHint: ["GET", "PUT", "DELETE", "QUERY"].includes(m),
    openWorldHint: true,
  };
}

/* ------------------------------------------------ OpenAPI */
function deref(spec, node, depth = 0) {
  if (depth > 6 || !node || typeof node !== "object") return node;
  if (node.$ref && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    let target = spec;
    for (const part of node.$ref.slice(2).split("/")) {
      target = (target && typeof target === "object") ? (target[part.replace(/~1/g, "/").replace(/~0/g, "~")] ?? {}) : {};
    }
    return deref(spec, target, depth + 1);
  }
  return node;
}
function schemaToJson(spec, sc, depth = 0) {
  sc = deref(spec, sc || {});
  if (!sc || typeof sc !== "object") return { type: "string" };
  let t = sc.type;
  if (!t) {
    if (sc.properties) t = "object";
    else if (sc.items) t = "array";
    else {
      for (const comb of ["allOf", "oneOf", "anyOf"]) {
        if (Array.isArray(sc[comb]) && sc[comb].length) return schemaToJson(spec, sc[comb][0], depth + 1);
      }
      t = "string";
    }
  }
  const out = { type: t };
  for (const k of ["description", "enum", "format", "default", "minimum", "maximum", "example"]) {
    if (sc[k] !== undefined) out[k] = sc[k];
  }
  if (t === "object" && depth < 4) {
    const props = {};
    for (const [pk, pv] of Object.entries(sc.properties || {})) props[pk] = schemaToJson(spec, pv, depth + 1);
    if (Object.keys(props).length) out.properties = props;
    if (Array.isArray(sc.required) && sc.required.length) out.required = sc.required;
  }
  if (t === "array" && depth < 4) out.items = schemaToJson(spec, sc.items || {}, depth + 1);
  return out;
}

export function parseOpenAPI(text) {
  let spec;
  try { spec = JSON.parse(text); } catch {
    try { spec = YAML.parse(text); } catch { throw new Error("Could not parse document as JSON or YAML."); }
  }
  if (!spec || typeof spec !== "object") throw new Error("Parsed document is not an object.");
  const paths = spec.paths;
  if (!paths || typeof paths !== "object") throw new Error("No `paths` object found — this doesn't look like an OpenAPI/Swagger document.");
  const isV2 = "swagger" in spec;
  let base = "";
  if (Array.isArray(spec.servers) && spec.servers[0]) base = spec.servers[0].url || "";
  else if (isV2 && spec.host) base = `${(spec.schemes || ["https"])[0]}://${spec.host}${spec.basePath || ""}`;
  const title = spec.info?.title || "API";
  const desc = spec.info?.description || "";
  const tools = [], seen = new Set();
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    const shared = item.parameters || [];
    for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      const raw = op.operationId || `${m}_${path.replace(/[{}]/g, "")}`;
      let name = toolname(raw);
      let i = 2;
      while (seen.has(name)) { name = toolname(raw).slice(0, MAX_TOOL_NAME - 3) + `_${i}`; i += 1; }
      seen.add(name);
      const props = {}, required = [], paramIn = {};
      for (let pr of [...shared, ...(op.parameters || [])]) {
        pr = deref(spec, pr);
        if (!pr || typeof pr !== "object" || !pr.name) continue;
        const psc = pr.schema || (isV2 ? Object.fromEntries(["type", "enum", "format", "default"].filter(k => k in pr).map(k => [k, pr[k]])) : {});
        const js = schemaToJson(spec, psc);
        js.description = pr.description || `(${pr.in || "query"} parameter)`;
        props[pr.name] = js;
        paramIn[pr.name] = pr.in || "query";
        if (pr.required) required.push(pr.name);
      }
      const bodyFields = [];
      let content = null, bodyRequired = false;
      if (isV2) {
        for (let pr of (op.parameters || [])) {
          pr = deref(spec, pr);
          if (pr && typeof pr === "object" && pr.in === "body") {
            content = { "application/json": { schema: pr.schema || {} } };
            if (pr.required) bodyRequired = true;
          }
        }
      } else {
        content = op.requestBody?.content || null;
        if (op.requestBody?.required) bodyRequired = true;
      }
      if (content) {
        const j = content["application/json"] || Object.values(content)[0];
        const sc = schemaToJson(spec, j?.schema || {});
        if (sc.type === "object" && sc.properties) {
          for (const [bk, bv] of Object.entries(sc.properties)) {
            if (bk in props) {
              const bk2 = "body_" + bk;
              props[bk2] = bv; paramIn[bk2] = "body"; bodyFields.push(bk);
            } else {
              props[bk] = bv; paramIn[bk] = "body"; bodyFields.push(bk);
            }
          }
          for (const rq of sc.required || []) if (!required.includes(rq)) required.push(rq);
        } else {
          props.body = sc && Object.keys(sc).length ? sc : { type: "object" };
          props.body.description = props.body.description || "Raw JSON request body";
          paramIn.body = "rawbody";
          if (bodyRequired) required.push("body");
        }
      }
      let outSchema = null;
      const responses = op.responses || {};
      let ok = deref(spec, responses["200"] || responses["201"] || responses.default || {});
      if (ok && typeof ok === "object") {
        if (isV2 && ok.schema) outSchema = schemaToJson(spec, ok.schema);
        else {
          const c = ok.content || {};
          const j = c["application/json"] || Object.values(c)[0];
          if (j?.schema) outSchema = schemaToJson(spec, j.schema);
        }
      }
      const summary = (op.summary || op.description || `${m.toUpperCase()} ${path}`).trim().split("\n")[0].slice(0, 220);
      tools.push({
        name, method: m.toUpperCase(), path,
        summary,
        description: (op.description || summary || "").trim().slice(0, 1000),
        input_schema: { type: "object", properties: props, required },
        output_schema: outSchema,
        annotations: annotations(m),
        governance: governance(m, path + " " + summary),
        mapping: { kind: "rest", param_in: paramIn, body_fields: bodyFields },
      });
    }
  }
  if (!tools.length) throw new Error("Parsed the document but found no operations under `paths`.");
  return { title, description: desc, base, protocol: "rest", count: tools.length, tools };
}

/* ------------------------------------------------ GraphQL */
const GQL_SCALARS = { Int: "integer", Float: "number", String: "string", Boolean: "boolean", ID: "string" };
function gqlTypeToSchema(t) {
  t = t.trim();
  const required = t.endsWith("!");
  t = t.replace(/!+$/, "").trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const [inner] = gqlTypeToSchema(t.slice(1, -1));
    return [{ type: "array", items: inner }, required];
  }
  const js = { type: GQL_SCALARS[t] || "object" };
  if (!(t in GQL_SCALARS)) js.description = `GraphQL type \`${t}\` (pass as object/JSON)`;
  return [js, required];
}
function stripGqlComments(sdl) {
  return sdl.replace(/"""[\s\S]*?"""/g, "").replace(/"[^"\n]*"/g, "").replace(/#[^\n]*/g, "");
}

export function parseGraphQL(text) {
  text = text.trim();
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const intro = data.data || data;
      if (intro.__schema) return parseIntrospection(intro.__schema);
    } catch { /* fall through to SDL */ }
  }
  const sdl = stripGqlComments(text);
  const tools = [];
  for (const [opKind, method] of [["Query", "QUERY"], ["Mutation", "MUTATION"]]) {
    const m = sdl.match(new RegExp(`type\\s+${opKind}\\s*(?:implements[^{]*)?\\{`));
    if (!m) continue;
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (i < sdl.length && depth) {
      if (sdl[i] === "{") depth += 1;
      else if (sdl[i] === "}") depth -= 1;
      i += 1;
    }
    const body = sdl.slice(start, i - 1);
    for (const fm of body.matchAll(/(\w+)\s*(\(([^)]*)\))?\s*:\s*([\[\]\w!]+)/g)) {
      const [, fname, , argstr, rtype] = fm;
      const props = {}, required = [], argTypes = {};
      for (const am of (argstr || "").matchAll(/(\w+)\s*:\s*([\[\]\w!]+)(\s*=\s*[^,)]+)?/g)) {
        const [, aname, atype, adef] = am;
        const [js, req] = gqlTypeToSchema(atype);
        props[aname] = js;
        argTypes[aname] = atype;
        if (req && !adef) required.push(aname);
      }
      const isMut = opKind === "Mutation";
      tools.push({
        name: toolname((isMut ? "mutate_" : "query_") + fname),
        method, path: fname,
        summary: `GraphQL ${opKind.toLowerCase()} \`${fname}\` → ${rtype.trim()}`,
        description: `Executes the GraphQL ${opKind.toLowerCase()} field \`${fname}\` (returns \`${rtype.trim()}\`).`,
        input_schema: { type: "object", properties: props, required },
        output_schema: null,
        annotations: annotations(isMut ? "MUTATION" : "QUERY"),
        governance: governance(isMut ? "POST" : "GET", fname),
        mapping: { kind: "graphql", operation: isMut ? "mutation" : "query", field: fname, arg_types: argTypes },
      });
    }
  }
  if (!tools.length) throw new Error("No Query/Mutation fields found. Paste GraphQL SDL (with `type Query {...}`) or an introspection JSON result.");
  return { title: "GraphQL API", description: "", base: "", protocol: "graphql", count: tools.length, tools };
}

function introType(t) {
  if (!t) return [{ type: "string" }, false];
  if (t.kind === "NON_NULL") { const [s] = introType(t.ofType); return [s, true]; }
  if (t.kind === "LIST") { const [s] = introType(t.ofType); return [{ type: "array", items: s }, false]; }
  if (t.kind === "SCALAR") return [{ type: GQL_SCALARS[t.name] || "string" }, false];
  if (t.kind === "ENUM") return [{ type: "string", description: `enum ${t.name}` }, false];
  return [{ type: "object", description: `GraphQL type \`${t.name}\`` }, false];
}
function introTypeName(t) {
  if (t.kind === "NON_NULL") return introTypeName(t.ofType) + "!";
  if (t.kind === "LIST") return "[" + introTypeName(t.ofType) + "]";
  return t.name || "String";
}
function parseIntrospection(schema) {
  const qname = schema.queryType?.name, mname = schema.mutationType?.name;
  const types = Object.fromEntries((schema.types || []).map(t => [t.name, t]));
  const tools = [];
  for (const [tname, method] of [[qname, "QUERY"], [mname, "MUTATION"]]) {
    const t = types[tname];
    if (!t) continue;
    for (const f of t.fields || []) {
      const props = {}, required = [], argTypes = {};
      for (const a of f.args || []) {
        const [js, req] = introType(a.type);
        js.description = js.description || a.description || "";
        props[a.name] = js;
        argTypes[a.name] = introTypeName(a.type);
        if (req && a.defaultValue == null) required.push(a.name);
      }
      const isMut = method === "MUTATION";
      tools.push({
        name: toolname((isMut ? "mutate_" : "query_") + f.name),
        method, path: f.name,
        summary: (f.description || `GraphQL ${method.toLowerCase()} \`${f.name}\``).split("\n")[0].slice(0, 220),
        description: (f.description || "").slice(0, 1000),
        input_schema: { type: "object", properties: props, required },
        output_schema: null,
        annotations: annotations(method),
        governance: governance(isMut ? "POST" : "GET", f.name),
        mapping: { kind: "graphql", operation: isMut ? "mutation" : "query", field: f.name, arg_types: argTypes },
      });
    }
  }
  if (!tools.length) throw new Error("Introspection result contained no query/mutation fields.");
  return { title: "GraphQL API", description: "", base: "", protocol: "graphql", count: tools.length, tools };
}

/* ------------------------------------------------ WSDL (regex-based, DOM-free) */
const XSD_TYPES = { string: "string", int: "integer", integer: "integer", long: "integer", short: "integer",
  decimal: "number", float: "number", double: "number", boolean: "boolean",
  date: "string", dateTime: "string", base64Binary: "string", anyURI: "string" };
const ln = s => s.includes(":") ? s.split(":").pop() : s;

export function parseWSDL(text) {
  const src = text.trim();
  if (!/<\s*(\w+:)?definitions[\s>]/.test(src)) {
    throw new Error("Root element is not <definitions> — this doesn't look like a WSDL document.");
  }
  const tnsM = src.match(/<\s*(?:\w+:)?definitions[^>]*targetNamespace\s*=\s*"([^"]*)"/);
  const tns = tnsM ? tnsM[1] : "";
  const nameM = src.match(/<\s*(?:\w+:)?definitions[^>]*\sname\s*=\s*"([^"]*)"/);
  const title = nameM ? nameM[1] : "SOAP Service";

  // top-level xsd elements with nested sequences
  const elements = {};
  for (const em of src.matchAll(/<\s*(?:\w+:)?element\s+name="(\w+)"\s*>([\s\S]*?)<\/\s*(?:\w+:)?element\s*>/g)) {
    const [, ename, body] = em;
    const props = {}, required = [];
    for (const sm of body.matchAll(/<\s*(?:\w+:)?element\s+name="(\w+)"[^>]*type="([\w:]+)"[^>]*?(\/?)>/g)) {
      const xt = ln(sm[2]);
      props[sm[1]] = { type: XSD_TYPES[xt] || "string", description: `XSD type ${xt}` };
      const minOcc = sm[0].match(/minOccurs="(\d+)"/);
      if (!minOcc || minOcc[1] !== "0") required.push(sm[1]);
    }
    elements[ename] = { props, required };
  }

  // messages: name -> {partName: elementOrType}
  const messages = {};
  for (const mm of src.matchAll(/<\s*(?:\w+:)?message\s+name="(\w+)"\s*>([\s\S]*?)<\/\s*(?:\w+:)?message\s*>/g)) {
    const parts = {};
    for (const pm of mm[2].matchAll(/<\s*(?:\w+:)?part\s+([^>]*)\/?\s*>/g)) {
      const attrs = pm[1];
      const pn = (attrs.match(/name="([^"]+)"/) || [])[1] || "parameters";
      const el = (attrs.match(/element="([^"]+)"/) || attrs.match(/type="([^"]+)"/) || [])[1] || "";
      parts[pn] = ln(el);
    }
    messages[mm[1]] = parts;
  }

  const epM = src.match(/<\s*(?:\w+:)?address[^>]*location="([^"]*)"/);
  const endpoint = epM ? epM[1] : "";

  // soapAction per operation (from bindings)
  const actions = {};
  for (const bm of src.matchAll(/<\s*(?:\w+:)?operation\s+name="(\w+)"\s*>[\s\S]*?soapAction="([^"]*)"/g)) {
    if (!(bm[1] in actions)) actions[bm[1]] = bm[2];
  }

  // portType operations
  const tools = [];
  for (const ptm of src.matchAll(/<\s*(?:\w+:)?(?:portType|interface)\b[^>]*>([\s\S]*?)<\/\s*(?:\w+:)?(?:portType|interface)\s*>/g)) {
    for (const om of ptm[1].matchAll(/<\s*(?:\w+:)?operation\s+name="(\w+)"\s*>([\s\S]*?)<\/\s*(?:\w+:)?operation\s*>/g)) {
      const [_, oname, obody] = om;
      const doc = ((obody.match(/<\s*(?:\w+:)?documentation\s*>([\s\S]*?)<\//) || [])[1] || "").trim();
      const inMsg = ln((obody.match(/<\s*(?:\w+:)?input[^>]*message="([^"]+)"/) || [])[1] || "");
      let props = {}, required = [], element = oname;
      const parts = messages[inMsg] || {};
      for (const [pname, ptype] of Object.entries(parts)) {
        if (ptype in elements) {
          element = ptype;
          Object.assign(props, elements[ptype].props);
          required.push(...elements[ptype].required);
        } else {
          props[pname] = { type: XSD_TYPES[ptype] || "string", description: `message part (${ptype})` };
          required.push(pname);
        }
      }
      tools.push({
        name: toolname("soap_" + oname),
        method: "SOAP", path: oname,
        summary: doc ? doc.split("\n")[0].slice(0, 220) : `SOAP operation ${oname}`,
        description: doc.slice(0, 1000) || `Invokes SOAP operation \`${oname}\` on ${title}.`,
        input_schema: { type: "object", properties: props, required: [...new Set(required)].sort() },
        output_schema: null,
        annotations: annotations("POST"),
        governance: governance("POST", oname + " " + doc),
        mapping: { kind: "soap", operation: oname, element, namespace: tns,
                   soap_action: actions[oname] || tns.replace(/\/$/, "") + "/" + oname, endpoint },
      });
    }
  }
  if (!tools.length) throw new Error("Parsed the WSDL but found no <operation> elements in any portType.");
  return { title, description: `SOAP service (${tns})`, base: endpoint, protocol: "soap", count: tools.length, tools };
}

/* ------------------------------------------------ gRPC .proto */
const PROTO_TYPES = { double: "number", float: "number", int32: "integer", int64: "integer",
  uint32: "integer", uint64: "integer", sint32: "integer", sint64: "integer",
  fixed32: "integer", fixed64: "integer", sfixed32: "integer", sfixed64: "integer",
  bool: "boolean", string: "string", bytes: "string" };

export function parseProto(text) {
  let src = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const pkg = (src.match(/package\s+([\w.]+)\s*;/) || [])[1] || "";
  const block = (s, start) => {
    let depth = 1, i = start;
    while (i < s.length && depth) {
      if (s[i] === "{") depth += 1;
      else if (s[i] === "}") depth -= 1;
      i += 1;
    }
    return s.slice(start, i - 1);
  };
  const messages = {};
  for (const mm of src.matchAll(/message\s+(\w+)\s*\{/g)) {
    const body = block(src, mm.index + mm[0].length);
    const props = {};
    for (const fm of body.matchAll(/(repeated\s+|optional\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+/g)) {
      const [, mod, ftype, fname] = fm;
      let base = { type: PROTO_TYPES[ftype] || "object" };
      if (!(ftype in PROTO_TYPES)) base.description = `proto message \`${ftype}\``;
      if (mod && mod.trim() === "repeated") base = { type: "array", items: base };
      props[fname] = base;
    }
    messages[mm[1]] = { props, required: [] };
  }
  const tools = [];
  for (const sm of src.matchAll(/service\s+(\w+)\s*\{/g)) {
    const sname = sm[1];
    const body = block(src, sm.index + sm[0].length);
    for (const rm of body.matchAll(/rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g)) {
      const [, rname, inStream, inT, outStream, outT] = rm;
      const msg = messages[inT.split(".").pop()] || { props: {}, required: [] };
      const outMsg = messages[outT.split(".").pop()];
      const read = /^(Get|List|Search|Query|Describe|Read|Watch|Lookup)/.test(rname);
      tools.push({
        name: toolname("grpc_" + rname),
        method: "RPC",
        path: `/${pkg ? pkg + "." : ""}${sname}/${rname}`,
        summary: `gRPC ${sname}.${rname}(${inT}) → ${outT}` + ((inStream || outStream) ? " [streaming]" : ""),
        description: `Invokes gRPC method \`${rname}\` on service \`${sname}\` via a JSON transcoding gateway (Connect / grpc-gateway).`,
        input_schema: { type: "object", properties: msg.props, required: msg.required },
        output_schema: outMsg ? { type: "object", properties: outMsg.props } : null,
        annotations: annotations(read ? "GET" : "POST"),
        governance: governance(read ? "GET" : "POST", rname),
        mapping: { kind: "grpc", service: (pkg ? pkg + "." : "") + sname, rpc: rname, streaming: !!(inStream || outStream) },
      });
    }
  }
  if (!tools.length) throw new Error("No `service` definitions with rpc methods found in the .proto file.");
  return { title: (pkg || "gRPC") + " service", description: `gRPC package ${pkg}`, base: "", protocol: "grpc", count: tools.length, tools };
}

export function parseSpec(protocol, text) {
  const fn = { rest: parseOpenAPI, graphql: parseGraphQL, soap: parseWSDL, grpc: parseProto }[protocol];
  if (!fn) throw new Error(`Unknown protocol '${protocol}'. Expected one of: rest, graphql, soap, grpc.`);
  return fn(text);
}

export const INTROSPECTION_QUERY = `
query IntrospectionQuery { __schema { queryType { name } mutationType { name }
 types { kind name description fields(includeDeprecated: false) { name description
  args { name description defaultValue type { ...T } } type { ...T } } } } }
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
`;
