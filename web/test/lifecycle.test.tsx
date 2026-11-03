import { test, expect, afterEach, mock } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api } from "../src/api.ts";
import { FieldImpact } from "../src/tabs/field-impact.tsx";
import { Permissions } from "../src/tabs/permissions.tsx";
import { Overview } from "../src/tabs/overview.tsx";
let tap: ((event: any) => void) | undefined;
const { default: realCytoscape } = await import("cytoscape");
mock.module("cytoscape", () => ({
  default: (options: any = {}) => {
    if (options.headless) return realCytoscape(options);
    const cy = realCytoscape({ headless: true });
    const on = cy.on.bind(cy);
    cy.on = ((event: string, node: string, cb: typeof tap) => {
      if (event === "tap" && node === "node") tap = cb;
      return on(event, node, cb as any);
    }) as typeof cy.on;
    return cy;
  },
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
  await act(async () =>
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
      .findByProps({ "aria-label": "Project" })
      .props.onChange({ target: { value: "2" } }),
  );
  await act(async () => tap!({ target: { data: () => ({ id: 22 }) } }));
  expect(calls).toEqual([1, 2]);
});

const { Explore } = await import("../src/tabs/explore.tsx");
const control = (label: string) =>
  renderer!.root.findByProps({ "aria-label": label });
const button = (name: string) =>
  renderer!.root
    .findAllByType("button")
    .find((b) => b.children.join("") === name)!;

test("Explore filters, show more, and expansion use current settings when recentering", async () => {
  api.schema = async () => ({
    nodeCounts: { ApexClass: 2, ApexMethod: 3 },
    edgeCounts: { CALLS: 2 },
  });
  const calls: Array<{ id: number; options: unknown }> = [];
  api.neighborhood = async (_p, id, options) => {
    calls.push({ id, options });
    return {
      centerId: id,
      truncated: true,
      nodes: [
        {
          id,
          name: "Center",
          qualifiedName: "Center",
          label: "ApexClass",
          filePath: null,
        },
      ],
      edges: [],
    };
  };
  await act(async () => {
    renderer = create(<Explore project={7} />, { createNodeMock: () => ({}) });
  });
  await act(async () => tap!({ target: { data: () => ({ id: 10 }) } }));
  await act(async () =>
    control("Node label").props.onChange({ target: { value: "ApexMethod" } }),
  );
  await act(async () =>
    control("Edge type").props.onChange({ target: { value: "CALLS" } }),
  );
  await act(async () => button("Show more").props.onClick());
  expect(calls.at(-1)).toEqual({
    id: 10,
    options: {
      depth: 1,
      cap: 1000,
      nodeLabel: "ApexMethod",
      edgeType: "CALLS",
    },
  });
  await act(async () => button("Expand one hop").props.onClick());
  expect(calls.at(-1)).toEqual({
    id: 10,
    options: {
      depth: 2,
      cap: 1000,
      nodeLabel: "ApexMethod",
      edgeType: "CALLS",
    },
  });
  await act(async () => tap!({ target: { data: () => ({ id: 20 }) } }));
  expect(calls.at(-1)).toEqual({
    id: 20,
    options: { depth: 1, cap: 500, nodeLabel: "ApexMethod", edgeType: "CALLS" },
  });
});

test("savings timeline displays zero-activity days and handles a single zero day", async () => {
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  api.savings = async () => ({
    totalCalls: 2,
    totalTokensSaved: 300,
    totalResultTokens: 0,
    totalBaselineTokens: 300,
    perTool: [],
    timeline: [
      { day: "2026-11-01", tokensSaved: 100, calls: 1 },
      { day: "2026-11-03", tokensSaved: 200, calls: 1 },
    ],
  });
  await act(async () => {
    renderer = create(<Overview project={1} />);
  });
  expect(renderer!.root.findAllByType("svg")).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).toContain("2026-11-02");
  expect(renderer!.root.findAllByType("tr")).toHaveLength(4);
  expect(JSON.stringify(renderer!.toJSON())).not.toMatch(/NaN|Infinity/);
  await act(async () => renderer!.unmount());
  api.savings = async () => ({
    totalCalls: 1,
    totalTokensSaved: 0,
    totalResultTokens: 0,
    totalBaselineTokens: 0,
    perTool: [],
    timeline: [{ day: "2026-11-03", tokensSaved: 0, calls: 1 }],
  });
  await act(async () => {
    renderer = create(<Overview project={1} />);
  });
  expect(renderer!.root.findAllByType("svg")).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).not.toMatch(/NaN|Infinity/);
});

test("method picker searches indexed methods and requests declaring-class grants", async () => {
  const searches: unknown[] = [];
  const grants: unknown[] = [];
  api.search = async (...args) => {
    searches.push(args);
    return {
      nodes: [
        {
          id: 4,
          name: "cleanup",
          qualifiedName: "AccountService.cleanup()",
          label: "ApexMethod",
          filePath: "/a.cls",
        },
      ],
      count: 1,
    };
  };
  api.permission = async (...args) => {
    grants.push(args);
    return {
      declaringClass: "AccountService",
      method: "AccountService.cleanup()",
      permission_sets: [],
    };
  };
  act(() => {
    renderer = create(<Permissions project={3} />);
  });
  act(() =>
    control("Target type").props.onChange({ target: { value: "ApexMethod" } }),
  );
  act(() =>
    control("Method search").props.onChange({
      target: { value: "AccountService" },
    }),
  );
  await act(async () => button("Find methods").props.onClick());
  expect(searches).toEqual([[3, "AccountService", "ApexMethod"]]);
  act(() =>
    control("Method").props.onChange({
      target: { value: "AccountService.cleanup()" },
    }),
  );
  await act(async () => button("Who has access?").props.onClick());
  expect(grants).toEqual([[3, "ApexMethod", "AccountService.cleanup()"]]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Declaring class:");
  expect(JSON.stringify(renderer!.toJSON())).toContain("AccountService");
});

test("leaving method mode invalidates a slow method search", async () => {
  const pending = deferred<{ nodes: any[]; count: number }>();
  api.search = () => pending.promise;
  act(() => {
    renderer = create(<Permissions project={3} />);
  });
  act(() =>
    control("Target type").props.onChange({ target: { value: "ApexMethod" } }),
  );
  act(() => button("Find methods").props.onClick());
  act(() =>
    control("Target type").props.onChange({ target: { value: "Field" } }),
  );
  await act(async () =>
    pending.resolve({
      nodes: [
        {
          id: 4,
          name: "stale",
          qualifiedName: "staleMethod()",
          label: "ApexMethod",
          filePath: null,
        },
      ],
      count: 1,
    }),
  );
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("staleMethod()");
});

test("an Explore failure clears stale data and offers a retry with the same settings", async () => {
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  let attempt = 0;
  api.neighborhood = async (_p, id) => {
    if (++attempt === 1) throw new Error("temporary failure");
    return {
      centerId: id,
      truncated: false,
      nodes: [
        {
          id,
          name: "Recovered",
          qualifiedName: "Recovered",
          label: "ApexClass",
          filePath: null,
        },
      ],
      edges: [],
    };
  };
  await act(async () => {
    renderer = create(<Explore project={1} />, { createNodeMock: () => ({}) });
  });
  await act(async () => tap!({ target: { data: () => ({ id: 10 }) } }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("temporary failure");
  await act(async () => button("Retry graph").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Recovered");
  expect(attempt).toBe(2);
});

test("edge-limited graphs explain the limit instead of offering ineffective Show more", async () => {
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  api.neighborhood = async (_p, id) => ({
    centerId: id,
    truncated: true,
    truncationReason: "edge_cap",
    nodes: [
      {
        id,
        name: "Dense",
        qualifiedName: "Dense",
        label: "ApexClass",
        filePath: null,
      },
    ],
    edges: [],
  });
  await act(async () => {
    renderer = create(<Explore project={1} />, { createNodeMock: () => ({}) });
  });
  await act(async () => tap!({ target: { data: () => ({ id: 10 }) } }));
  expect(button("Show more") === undefined).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("edge limit");
});

test("expansion keeps the current graph visible while loading more nodes", async () => {
  api.schema = async () => ({ nodeCounts: {}, edgeCounts: {} });
  const pending = deferred<any>();
  let count = 0;
  api.neighborhood = async (_p, id) =>
    ++count === 1
      ? {
          centerId: id,
          truncated: true,
          nodes: [
            {
              id,
              name: "Retained",
              qualifiedName: "Retained",
              label: "ApexClass",
              filePath: null,
            },
          ],
          edges: [],
        }
      : pending.promise;
  await act(async () => {
    renderer = create(<Explore project={1} />, { createNodeMock: () => ({}) });
  });
  await act(async () => tap!({ target: { data: () => ({ id: 10 }) } }));
  await act(async () => button("Show more").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Retained");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Loading graph");
  await act(async () =>
    pending.resolve({ centerId: 10, truncated: false, nodes: [], edges: [] }),
  );
});
