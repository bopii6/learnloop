"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CourseBlueprint, BlueprintUnit, BlueprintLecture } from "@/types";

interface BlueprintEditorProps {
  blueprint: CourseBlueprint;
  onChange: (edited: CourseBlueprint) => void;
  loading?: boolean;
}

const DEPTH_COLORS: Record<string, string> = {
  "建立直觉": "bg-blue-50 text-blue-700 border-blue-200",
  "正式定义": "bg-green-50 text-green-700 border-green-200",
  "公式推导": "bg-purple-50 text-purple-700 border-purple-200",
  "进阶理论": "bg-orange-50 text-orange-700 border-orange-200",
  "应用实操": "bg-rose-50 text-rose-700 border-rose-200",
};

// ---- 自定义节点：课程根节点 ----
function CourseRootNode({ data }: NodeProps) {
  const d = data as { title: string; tags: string[]; totalLectures: number };
  return (
    <div className="rounded-2xl border-2 border-accent bg-white shadow-lg p-5 w-56">
      <Handle type="source" position={Position.Right} className="!bg-accent !w-2 !h-2" />
      <div className="text-[15px] font-bold leading-snug mb-2">{d.title}</div>
      <div className="flex gap-1 flex-wrap mb-2">
        {d.tags.map((t) => (
          <span key={t} className="rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px]">
            {t}
          </span>
        ))}
      </div>
      <div className="text-[11px] text-ink-faint">{d.totalLectures} 个课节</div>
    </div>
  );
}

// ---- 自定义节点：单元节点（点击卡片展开/收起课节） ----
function UnitNode({ data }: NodeProps) {
  const d = data as {
    unit: BlueprintUnit;
    index: number;
    expanded: boolean;
    lectureCount: number;
    hovered: boolean;
    onToggle: () => void;
    onSplit: () => void;
    onDelete: () => void;
  };
  return (
    <div
      className={`rounded-2xl border-2 shadow-md p-4 w-52 relative group cursor-pointer transition-colors ${
        d.expanded ? "border-accent bg-accent/5" : "border-accent/30 bg-white hover:border-accent/60"
      }`}
      onClick={(e) => { e.stopPropagation(); d.onToggle(); }}
      title={d.expanded ? "点击收起课节" : "点击展开课节"}
    >
      <Handle type="target" position={Position.Left} className="!bg-accent/60 !w-2 !h-2" />
      <Handle type="source" position={Position.Right} className="!bg-accent/60 !w-2 !h-2" />
      <div className="flex items-center justify-between mb-0.5">
        <div className="text-[11px] text-accent font-semibold">
          单元 {String(d.index + 1).padStart(2, "0")}
        </div>
        <div className="text-[10px] text-ink-faint">
          {d.expanded ? "▾" : "▸"} {d.lectureCount} 讲
        </div>
      </div>
      <div className="text-[13px] font-semibold leading-snug">{d.unit.title}</div>
      {!d.expanded && (
        <div className="text-[10.5px] text-ink-soft mt-1 leading-relaxed line-clamp-2">
          {d.unit.summary}
        </div>
      )}
      {/* 悬停操作 */}
      <div className="absolute -top-2.5 -right-2.5 hidden group-hover:flex gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); d.onSplit(); }}
          title="拆分单元"
          className="w-6 h-6 rounded-full bg-white border border-[#d3d1c7] text-[11px] shadow-sm hover:border-accent hover:text-accent flex items-center justify-center nodrag"
        >
          ✂
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); d.onDelete(); }}
          title="删除单元"
          className="w-6 h-6 rounded-full bg-white border border-[#d3d1c7] text-[11px] shadow-sm hover:border-red-400 hover:text-red-500 flex items-center justify-center nodrag"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ---- 自定义节点：课节节点 ----
function LectureNode({ data }: NodeProps) {
  const d = data as {
    lecture: BlueprintLecture;
    index: number;
    onDelete: () => void;
  };
  return (
    <div className="rounded-xl border border-[#e7e5dc] bg-white shadow-sm p-3 w-48 relative group">
      <Handle type="target" position={Position.Left} className="!bg-[#d3d1c7] !w-1.5 !h-1.5" />
      <div className="text-[10px] text-ink-faint mb-0.5">
        讲次 {String(d.index + 1).padStart(2, "0")}
      </div>
      <div className="text-[12px] font-medium leading-snug mb-1.5">
        {d.lecture.title}
      </div>
      <div className="flex gap-1 flex-wrap">
        {d.lecture.depth_tags.map((tag) => (
          <span
            key={tag}
            className={`rounded-full px-1.5 py-0.5 text-[9px] border ${DEPTH_COLORS[tag] || "bg-[#f1efe8] text-ink-soft border-[#e7e5dc]"}`}
          >
            {tag}
          </span>
        ))}
      </div>
      {/* 悬停删除 */}
      <button
        onClick={(e) => { e.stopPropagation(); d.onDelete(); }}
        title="删除课节"
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-[#d3d1c7] text-[9px] shadow-sm hover:border-red-400 hover:text-red-500 hidden group-hover:flex items-center justify-center nodrag"
      >
        ×
      </button>
    </div>
  );
}

// ---- 自定义节点：加深按钮 ----
function DeepenNode({ data }: NodeProps) {
  const d = data as { onClick: () => void };
  return (
    <div className="w-48">
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-none !w-0 !h-0" />
      <button
        onClick={(e) => { e.stopPropagation(); d.onClick(); }}
        className="w-full rounded-xl border border-dashed border-[#d3d1c7] py-2 text-[11px] text-ink-faint hover:border-accent hover:text-accent transition-colors bg-white/50 nodrag"
      >
        + 讲深一节
      </button>
    </div>
  );
}

const nodeTypes = {
  courseRoot: CourseRootNode,
  unit: UnitNode,
  lecture: LectureNode,
  deepen: DeepenNode,
};

// ---- 布局计算 ----
function layoutNodes(
  blueprint: CourseBlueprint,
  expandedUnits: Set<string>,
  callbacks: {
    onDeleteLecture: (unitId: string, lecId: string) => void;
    onDeleteUnit: (unitId: string) => void;
    onSplitUnit: (unitId: string) => void;
    onDeepen: (unitId: string) => void;
    onToggleUnit: (unitId: string) => void;
  }
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const totalLectures = blueprint.units.reduce((s, u) => s + u.lectures.length, 0);

  const LEC_HEIGHT = 76; // 每个课节卡片高度 + 间距
  const UNIT_GAP = 28;
  const DEEPEN_HEIGHT = 46;

  // 高度只按"展开的单元"计算，折叠单元只占一行 → 初始视野容纳全部单元
  const unitHeights: number[] = [];
  let totalHeight = 0;
  for (const u of blueprint.units) {
    const h = expandedUnits.has(u.id)
      ? u.lectures.length * LEC_HEIGHT + DEEPEN_HEIGHT
      : 64;
    unitHeights.push(h);
    totalHeight += h + UNIT_GAP;
  }

  // 根节点：垂直居中
  const rootY = totalHeight / 2;
  nodes.push({
    id: "root",
    type: "courseRoot",
    position: { x: 0, y: rootY },
    data: {
      title: blueprint.title,
      tags: blueprint.tags,
      totalLectures,
    },
    draggable: false,
  });

  let curY = 0;
  for (let ui = 0; ui < blueprint.units.length; ui++) {
    const unit = blueprint.units[ui];
    const unitHeight = unitHeights[ui];
    const expanded = expandedUnits.has(unit.id);
    const unitY = curY + unitHeight / 2 - 20; // 单元节点垂直居中于其课节

    // 单元节点
    nodes.push({
      id: unit.id,
      type: "unit",
      position: { x: 320, y: unitY },
      data: {
        unit,
        index: ui,
        expanded,
        lectureCount: unit.lectures.length,
        onToggle: () => callbacks.onToggleUnit(unit.id),
        onSplit: () => callbacks.onSplitUnit(unit.id),
        onDelete: () => callbacks.onDeleteUnit(unit.id),
      },
      draggable: false,
    });

    // 根 → 单元连线
    edges.push({
      id: `root-${unit.id}`,
      source: "root",
      target: unit.id,
      type: "smoothstep",
      style: { stroke: "#846358", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#846358", width: 16, height: 16 },
    });

    // 课节节点（折叠单元的课节隐藏，不参与布局视野）
    if (expanded) {
      let lecY = curY;
      for (let li = 0; li < unit.lectures.length; li++) {
        const lec = unit.lectures[li];
        nodes.push({
          id: lec.id,
          type: "lecture",
          position: { x: 620, y: lecY },
          data: {
            lecture: lec,
            index: li,
            onDelete: () => callbacks.onDeleteLecture(unit.id, lec.id),
          },
          draggable: false,
        });

        edges.push({
          id: `${unit.id}-${lec.id}`,
          source: unit.id,
          target: lec.id,
          type: "smoothstep",
          style: { stroke: "#d3d1c7", strokeWidth: 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#d3d1c7", width: 12, height: 12 },
        });

        lecY += LEC_HEIGHT;
      }

      // 加深按钮
      nodes.push({
        id: `deepen-${unit.id}`,
        type: "deepen",
        position: { x: 620, y: lecY },
        data: { onClick: () => callbacks.onDeepen(unit.id) },
        draggable: false,
        selectable: false,
      });

      // 单元 → 加深按钮连线（虚线）
      edges.push({
        id: `${unit.id}-deepen`,
        source: unit.id,
        target: `deepen-${unit.id}`,
        type: "smoothstep",
        style: { stroke: "#d3d1c7", strokeWidth: 1, strokeDasharray: "4 4" },
      });
    }

    curY += unitHeight + UNIT_GAP;
  }

  return { nodes, edges };
}

// ---- 主组件 ----
export function BlueprintEditor({ blueprint, onChange, loading }: BlueprintEditorProps) {
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(() => new Set(blueprint.units.slice(0, 1).map((u) => u.id)));
  const [expanded, setExpanded] = useState(false); // 全屏展开导图
  const toggleUnit = useCallback((unitId: string) => {
    setExpandedUnits((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  }, []);

  const deleteLecture = useCallback(
    (unitId: string, lectureId: string) => {
      const next = {
        ...blueprint,
        units: blueprint.units
          .map((u) =>
            u.id === unitId
              ? { ...u, lectures: u.lectures.filter((l) => l.id !== lectureId) }
              : u
          )
          .filter((u) => u.lectures.length > 0),
      };
      onChange(next);
    },
    [blueprint, onChange]
  );

  const deleteUnit = useCallback(
    (unitId: string) => {
      onChange({
        ...blueprint,
        units: blueprint.units.filter((u) => u.id !== unitId),
      });
    },
    [blueprint, onChange]
  );

  const splitUnit = useCallback(
    (unitId: string) => {
      const idx = blueprint.units.findIndex((u) => u.id === unitId);
      if (idx === -1) return;
      const unit = blueprint.units[idx];
      const mid = Math.ceil(unit.lectures.length / 2);
      const first: BlueprintUnit = { ...unit, lectures: unit.lectures.slice(0, mid) };
      const second: BlueprintUnit = {
        ...unit,
        id: `${unit.id}-b`,
        title: `${unit.title}（续）`,
        lectures: unit.lectures.slice(mid),
      };
      const units = [...blueprint.units];
      units.splice(idx, 1, first, second);
      onChange({ ...blueprint, units });
    },
    [blueprint, onChange]
  );

  const deepenLecture = useCallback(
    (unitId: string) => {
      const unit = blueprint.units.find((u) => u.id === unitId);
      if (!unit) return;
      const lastLec = unit.lectures[unit.lectures.length - 1];
      const newId = `lec-${unit.id.replace("unit-", "")}-${unit.lectures.length + 1}`;
      const nextDepth = lastLec?.depth_tags.includes("进阶理论")
        ? ["应用实操"]
        : lastLec?.depth_tags.includes("正式定义")
          ? ["进阶理论"]
          : ["正式定义"];
      const newLec: BlueprintLecture = {
        id: newId,
        title: `${unit.key_concepts[0] || unit.title}：进阶专题`,
        depth_tags: nextDepth,
      };
      onChange({
        ...blueprint,
        units: blueprint.units.map((u) =>
          u.id === unitId ? { ...u, lectures: [...u.lectures, newLec] } : u
        ),
      });
    },
    [blueprint, onChange]
  );

  const { nodes, edges } = useMemo(
    () =>
      layoutNodes(blueprint, expandedUnits, {
        onDeleteLecture: deleteLecture,
        onDeleteUnit: deleteUnit,
        onSplitUnit: splitUnit,
        onDeepen: deepenLecture,
        onToggleUnit: toggleUnit,
      }),
    [blueprint, expandedUnits, deleteLecture, deleteUnit, splitUnit, deepenLecture, toggleUnit]
  );

  if (loading) {
    return (
      <div className="rounded-2xl border border-[#e7e5dc] bg-white p-6 h-[500px] flex items-center justify-center">
        <div className="animate-pulse space-y-4 text-center">
          <div className="h-5 bg-[#e7e5dc] rounded w-48 mx-auto"></div>
          <div className="h-4 bg-[#e7e5dc] rounded w-64 mx-auto"></div>
          <div className="text-[13px] text-ink-soft mt-4">正在生成课程结构...</div>
        </div>
      </div>
    );
  }

  const DEPTH_TAG_LIST = ["建立直觉", "正式定义", "公式推导", "进阶理论", "应用实操"];
  const totalLectures = blueprint.units.reduce((s, u) => s + u.lectures.length, 0);

  const canvas = (
    <div className="relative bg-white overflow-hidden" style={{ height: expanded ? "100%" : "clamp(560px, 68vh, 820px)" }}>
      <ReactFlowProvider>
        <FlowCanvas nodes={nodes} edges={edges} refitKey={`${expandedUnits.size}-${blueprint.units.length}-${nodes.length}-${expanded ? "full" : "card"}`} />
      </ReactFlowProvider>
      {/* 展开全屏按钮（原版同款位置：卡右上角） */}
      <button
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "收起" : "全屏展开"}
        className="absolute top-3 right-3 z-10 w-8 h-8 rounded-lg border border-[#e7e5dc] bg-white shadow-sm hover:border-accent hover:text-accent text-ink-soft flex items-center justify-center"
      >
        {expanded ? "⤡" : "⤢"}
      </button>
    </div>
  );

  const cardHeader = (
    <div className="p-5 pb-3">
      <div className="text-[12px] text-accent font-medium mb-1">课程讲解结构</div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[17px] font-bold leading-snug">{blueprint.title}</span>
        <span className="rounded-full bg-[#f1efe8] px-2.5 py-0.5 text-[11px] text-ink-soft shrink-0">
          {totalLectures} 课节
        </span>
      </div>
      <div className="text-[12.5px] text-ink-soft mt-1">{blueprint.audience}</div>
      <div className="flex items-center gap-2 flex-wrap mt-3">
        <span className="text-[11px] text-ink-faint mr-1">课节深度</span>
        {DEPTH_TAG_LIST.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] border ${DEPTH_COLORS[tag] || "bg-[#f1efe8] text-ink-soft border-[#e7e5dc]"}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
            {tag}
          </span>
        ))}
      </div>
    </div>
  );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-[60] bg-white flex flex-col">
        <div className="p-5 pb-0">
          {cardHeader}
        </div>
        <div className="flex-1 min-h-0">{canvas}</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden">
      {cardHeader}
      {canvas}
    </div>
  );
}

/** 画布独立组件：refitKey 变化（展开/收起单元）时自动 fitView */
function FlowCanvas({
  nodes,
  edges,
  refitKey,
}: {
  nodes: Node[];
  edges: Edge[];
  refitKey: string;
}) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const t = window.setTimeout(() => void fitView({ padding: 0.12, duration: 300 }), 60);
    return () => window.clearTimeout(t);
  }, [refitKey, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.45}
      maxZoom={1.15}
      panOnDrag
      panOnScroll
      zoomOnScroll
      nodesDraggable={false}
      nodesConnectable={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#e7e5dc" gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
