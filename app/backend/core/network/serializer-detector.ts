import type { SerializerEntry } from "./types.js";

interface RpcLike {
    call<T>(method: string, args?: unknown[]): Promise<T>;
}

interface ClassMembers {
    methods: string[];
    fields: string[];
}

interface Pattern {
    name: string;
    className: string;
    ns: string;
    sendMethod: string;
    recvMethod: string;
    sendSignature: string;
    recvSignature: string;
    sendParamIndex?: number;
    recvParamIndex?: number;
}

const PATTERNS: Pattern[] = [
    {
        name: "Google.Protobuf",
        className: "MessageExtensions",
        ns: "Google.Protobuf",
        sendMethod: "WriteDelimitedTo",
        recvMethod: "MergeDelimitedFrom",
        sendSignature: "(Google.Protobuf.IMessage,System.IO.Stream):System.Void",
        recvSignature: "(Google.Protobuf.IMessage,System.IO.Stream):System.Void",
        sendParamIndex: 0,
        recvParamIndex: 0,
    },
    {
        name: "MessagePack",
        className: "MessagePackSerializer",
        ns: "MessagePack",
        sendMethod: "Serialize",
        recvMethod: "Deserialize",
        sendSignature: "(System.Object):System.Byte[]",
        recvSignature: "(System.Byte[]):System.Object",
        sendParamIndex: 0,
    },
    {
        name: "Mirror",
        className: "NetworkWriter",
        ns: "Mirror",
        sendMethod: "Write",
        recvMethod: "Read",
        sendSignature: "(System.Object):System.Void",
        recvSignature: "():System.Object",
        sendParamIndex: 0,
    },
];

export async function detectSerializers(rpc: RpcLike): Promise<SerializerEntry[]> {
    const out: SerializerEntry[] = [];
    for (const p of PATTERNS) {
        const fullName = `${p.ns}.${p.className}`;
        const info = await rpc
            .call<ClassMembers>("listClassMembers", [fullName])
            .catch(() => ({ methods: [], fields: [] } as ClassMembers));
        if (!info || !Array.isArray(info.methods) || info.methods.length === 0) continue;
        const hasSend = info.methods.includes(p.sendMethod);
        const hasRecv = info.methods.includes(p.recvMethod);
        if (!hasSend || !hasRecv) continue;

        const now = new Date().toISOString();
        out.push({
            source: "auto",
            direction: "send",
            className: p.className,
            ns: p.ns,
            methodName: p.sendMethod,
            methodSignature: p.sendSignature,
            paramIndex: p.sendParamIndex,
            disabled: true,
            addedAt: now,
        });
        out.push({
            source: "auto",
            direction: "recv",
            className: p.className,
            ns: p.ns,
            methodName: p.recvMethod,
            methodSignature: p.recvSignature,
            paramIndex: p.recvParamIndex,
            disabled: true,
            addedAt: now,
        });
    }
    return out;
}
