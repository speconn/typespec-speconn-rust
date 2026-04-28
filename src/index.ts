import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Operation,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  IntrinsicType,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface RpcInfo {
  name: string;
  originalName: string;
  path: string;
  inputType: Model | null;
  outputType: Model | null;
  isStream: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  serviceFQN: string;
  rpcs: RpcInfo[];
  models: Model[];
}

interface FileNames {
  types: string;
  server: string;
  client: string;
}

// ==================== Helpers ====================

function isStreamOp(_program: Program, op: Operation): boolean {
  const returnModel = op.returnType;
  if (returnModel && returnModel.kind === "Model" && returnModel.name && returnModel.name.includes("Stream")) return true;
  return false;
}

function resolveInputModel(op: Operation): Model | null {
  if (op.parameters && op.parameters.kind === "Model") {
    const params = op.parameters;
    if (params.name && params.name !== "") return params;
    if (params.sourceModels && params.sourceModels.length > 0) {
      for (const sm of params.sourceModels) {
        const src = sm.model;
        if (src.kind === "Model" && src.name && src.name !== "") return src;
      }
    }
    if (params.sourceModel && params.sourceModel.name && params.sourceModel.name !== "") {
      return params.sourceModel;
    }
  }
  return null;
}

function resolveOutputModel(op: Operation): Model | null {
  if (op.returnType && op.returnType.kind === "Model") return op.returnType;
  return null;
}

function computeProcedurePath(ns: Namespace, iface: Interface, op: Operation): string {
  const nsFQN = getNamespaceFullName(ns);
  return `/${nsFQN}.${iface.name}/${op.name}`;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const nsFQN = getNamespaceFullName(ns);
      const serviceName = iface.name;
      const rpcs: RpcInfo[] = [];
      const models: Model[] = [];
      const seen = new Set<string>();

      for (const [opName, op] of iface.operations) {
        const path = computeProcedurePath(ns, iface, op);
        const inputModel = resolveInputModel(op);
        const outputModel = resolveOutputModel(op);

        if (inputModel && inputModel.name && !seen.has(inputModel.name)) {
          models.push(inputModel);
          seen.add(inputModel.name);
        }
        if (outputModel && outputModel.name && !seen.has(outputModel.name)) {
          models.push(outputModel);
          seen.add(outputModel.name);
        }

        rpcs.push({ name: opName.charAt(0).toLowerCase() + opName.slice(1), originalName: opName, path, inputType: inputModel, outputType: outputModel, isStream: isStreamOp(program, op) });
      }

      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });

      result.push({ namespace: ns, iface, serviceName, serviceFQN: `${nsFQN}.${serviceName}`, rpcs, models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);

  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }

  return result;
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

// ==================== File Naming ====================

function snakeBase(s: string): string {
  return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function camelBase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function fileNamesFor(serviceName: string): FileNames {
  const snake = snakeBase(serviceName);
  return {
    types: `${snake}_types.rs`,
    server: `${snake}_server.rs`,
    client: `${snake}_client.rs`,
  };
}

// ==================== Type Mappers ====================

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "string";
  if (type.kind === "Intrinsic") return (type as any).name === "string";
  return false;
}

function isIntType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "int8" || n === "int16" || n === "int32" || n === "int64" || n === "uint8" || n === "uint16" || n === "uint32" || n === "uint64" || n === "integer";
  }
  return false;
}

function isFloatType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "float" || n === "float32" || n === "float64" || n === "decimal";
  }
  return false;
}

function isBoolType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "boolean";
  if (type.kind === "Intrinsic") return (type as any).name === "boolean";
  return false;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToRust(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "i64";
  if (isFloatType(type)) return "f64";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `Vec<${typeToRust(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "serde_json::Value";
  return "serde_json::Value";
}

// ==================== Rust Emitter ====================

function emitRust(program: Program, services: ServiceInfo[], outputDir: string): Promise<void[]> {
  const promises: Promise<void>[] = [];

  for (const svc of services) {
    if (svc.rpcs.length === 0) continue;
    const fn = fileNamesFor(svc.serviceName);
    const typesMod = fn.types.replace(/\.rs$/, "");
    const reqName = (rpc: RpcInfo) => rpc.inputType?.name || "()";
    const resName = (rpc: RpcInfo) => rpc.outputType?.name || "()";

    const types: string[] = [];
    types.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    types.push("use serde::{Deserialize, Serialize};\n");
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      types.push("#[derive(Deserialize, Serialize, Clone, Debug)]");
      types.push(`pub struct ${m.name} {`);
      for (const f of fields) {
        const t = f.optional ? `Option<${typeToRust(f.type)}>` : typeToRust(f.type);
        types.push(`    pub ${f.name}: ${t},`);
      }
      types.push('}\n');
    }
    const constPrefix = snakeBase(svc.serviceName).toUpperCase();
    for (const rpc of svc.rpcs) {
      types.push(`pub const ${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE: &str = "${rpc.path}";`);
    }
    types.push('');

    const server: string[] = [];
    server.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    server.push(`use speconn::{SpeconnRouter, SpeconnContext, SpeconnError};`);
    const serverTypeImports = svc.models.filter(m => m.name).map(m => m.name);
    const serverProcImports = svc.rpcs.map(rpc => `${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE`);
    server.push(`use crate::${typesMod}::{${[...serverTypeImports, ...serverProcImports].join(", ")}};\n`);
    server.push(`pub fn ${snakeBase(svc.serviceName)}_router(`);
    for (const rpc of svc.rpcs) {
      server.push(`    ${rpc.name}_fn: impl Fn(&SpeconnContext, ${reqName(rpc)}) -> Result<${resName(rpc)}, SpeconnError> + Send + Sync + 'static,`);
    }
    server.push(`) -> SpeconnRouter {`);
    server.push(`    SpeconnRouter::new()`);
    for (const rpc of svc.rpcs) {
      server.push(`        .${rpc.isStream ? "server_stream" : "unary"}(${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE, ${rpc.name}_fn)`);
    }
    server.push(`}\n`);

    const client: string[] = [];
    client.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    client.push(`use speconn::{SpeconnClient as SpeconnClientBase, SpeconnError, Transport, CallOption};`);
    const clientTypeImports = svc.models.filter(m => m.name).map(m => m.name);
    const clientProcImports = svc.rpcs.map(rpc => `${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE`);
    client.push(`use crate::${typesMod}::{${[...clientTypeImports, ...clientProcImports].join(", ")}};\n`);
    client.push(`pub struct ${svc.serviceName}Client<T: Transport> {`);
    client.push(`    inner: SpeconnClientBase<T>,`);
    client.push('}\n');
    client.push(`impl<T: Transport> ${svc.serviceName}Client<T> {`);
    client.push(`    pub fn new(base_url: &str, transport: T) -> Self { ${svc.serviceName}Client { inner: SpeconnClientBase::new(base_url, transport) } }`);
    for (const rpc of svc.rpcs) {
      if (rpc.isStream) {
        client.push(`    pub async fn ${rpc.name}(&self, req: &${reqName(rpc)}, options: &[CallOption]) -> Result<Vec<${resName(rpc)}>, SpeconnError> {`);
        client.push(`        self.inner.stream(${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE, req, options).await`);
      } else {
        client.push(`    pub async fn ${rpc.name}(&self, req: &${reqName(rpc)}, options: &[CallOption]) -> Result<${resName(rpc)}, SpeconnError> {`);
        client.push(`        self.inner.call(${constPrefix}_${rpc.originalName.toUpperCase()}_PROCEDURE, req, options).await`);
      }
      client.push(`    }`);
    }
    client.push('}\n');

    promises.push(emitFile(program, { path: `${outputDir}/${fn.types}`, content: types.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.server}`, content: server.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.client}`, content: client.join("\n") }));
  }
  return Promise.all(promises);
}

// ==================== Main Emitter ====================

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const services = collectServices(program);
  await emitRust(program, services, outputDir);
}
