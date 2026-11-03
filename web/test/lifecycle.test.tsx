import { test, expect, afterEach, mock } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api } from "../src/api.ts";
import { FieldImpact } from "../src/tabs/field-impact.tsx";
import { Permissions } from "../src/tabs/permissions.tsx";
import { Overview } from "../src/tabs/overview.tsx";
let tap: ((event: any) => void) | undefined;
mock.module("cytoscape", () => ({
  default: () => ({
    on: (_event: string, _node: string, cb: typeof tap) => {
      tap = cb;
    },
    destroy() {},
    elements: () => ({ remove() {} }),
    add() {},
    layout: () => ({ run() {} }),
  }),
}));
const { App } = await import("../src/app.tsx");
const original = { ...api };
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  Object.assign(api, original);
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("reports ignore older requests and clear on failed requests", async () => {
  const first = deferred<Record<string, unknown>>(),
    second = deferred<Record<string, unknown>>();
  let count = 0;
  api.fieldUsage = () => (++count === 1 ? first.promise : second.promise);
  act(() => {
    renderer = create(<FieldImpact project={1} />);
  });
  act(() => {
    renderer!.root.findByType("button").props.onClick();
    renderer!.root.findByType("button").props.onClick();
  });
  await act(async () =>
    second.resolve({
      apex_methods: [{ qualified_name: "new", context: "SOQL_WHERE" }],
    }),
  );
  await act(async () =>
    first.resolve({
      apex_methods: [
        { qualified_name: "staleFieldResult", context: "SOQL_SELECT" },
      ],
    }),
  );
  expect(JSON.stringify(renderer!.toJSON())).toContain("new");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("staleFieldResult");
  api.fieldUsage = async () => {
    throw new Error("offline");
  };
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("offline");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("SOQL_WHERE");
});

test("permission reports do not restore results from an older target", async () => {
  const old = deferred<Record<string, unknown>>();
  let count = 0;
  api.permission = async () =>
    ++count === 1
      ? old.promise
      : { permission_sets: [{ source_qualified_name: "current", access: {} }] };
  act(() => {
    renderer = create(<Permissions project={1} />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
    renderer!.root.findByType("button").props.onClick();
  });
  await act(async () =>
    old.resolve({
      permission_sets: [{ source_qualified_name: "stale", access: {} }],
    }),
  );
  expect(JSON.stringify(renderer!.toJSON())).toContain("current");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("stale");
});

test("overview failures show an error instead of permanent loading", async () => {
  api.savings = async () => {
    throw new Error("service unavailable");
  };
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  await act(async () => {
    renderer = create(<Overview project={1} />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("service unavailable");
});

test("project switch remounts Explore and node taps use the selected project", async () => {
  api.projects = async () => [
    { id: 1, name: "A", rootPath: "/a", nodeCount: 1, edgeCount: 0 },
    { id: 2, name: "B", rootPath: "/b", nodeCount: 1, edgeCount: 0 },
  ];
  api.savings = async () => ({
    totalCalls: 0,
    totalTokensSaved: 0,
    totalResultTokens: 0,
    totalBaselineTokens: 0,
    perTool: [],
    timeline: [],
  });
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  const calls: number[] = [];
  api.neighborhood = async (p, id) => {
    calls.push(p);
    return { centerId: id, truncated: false, nodes: [], edges: [] };
  };
  await act(async () => {
    renderer = create(<App />, { createNodeMock: () => ({}) });
  });
  act(() =>
    renderer!.root
      .findAll(
        (n) =>
          n.props.className?.includes("tab") && n.children[0] === "Explore",
      )[0]!
      .props.onClick(),
  );
  await act(async () => tap!({ target: { data: () => ({ id: 11 }) } }));
  act(() =>
    renderer!.root
      .findByType("select")
      .props.onChange({ target: { value: "2" } }),
  );
  await act(async () => tap!({ target: { data: () => ({ id: 22 }) } }));
  expect(calls).toEqual([1, 2]);
});
