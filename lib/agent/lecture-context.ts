// 课节上下文：白板课（/api/board）与回放（/api/replay）共用的"这节课讲什么、讲给谁"。
import type { CourseOutline } from "@/types";

export interface LectureContext {
  courseTitle: string;
  unitTitle: string;
  lectureTitle: string;
  lectureSummary: string;
  depthTags: string[];
  audience: string;
  keyConcepts?: string[]; // 本单元关键概念
  outputLanguage?: string; // 建课时用户要求的输出语言
  constraints?: string[]; // 用户的其他硬性要求（原话关键词）
  previousLectures?: { title: string; summary: string }[]; // 同单元里排在前面的讲：开场接住、不重讲
  unitProgress?: { index: number; total: number }; // 本讲在单元内的位置
}

/** 从课程大纲中提取课节上下文 */
export function buildLectureContext(outline: CourseOutline, unitId: string, lectureId: string): LectureContext | null {
  const unit = outline.units.find((u) => u.id === unitId);
  const lectureIndex = unit?.lectures.findIndex((l) => l.id === lectureId) ?? -1;
  const lecture = lectureIndex >= 0 ? unit!.lectures[lectureIndex] : undefined;
  if (!unit || !lecture) return null;
  const previousLectures = unit.lectures
    .slice(0, lectureIndex)
    .filter((l) => l.content_type !== "quiz" && l.content_type !== "project")
    .map((l) => ({ title: l.title, summary: l.summary }));
  return {
    courseTitle: outline.title,
    unitTitle: unit.title,
    lectureTitle: lecture.title,
    lectureSummary: lecture.summary,
    depthTags: lecture.depth_tags,
    audience: outline.audience,
    keyConcepts: unit.key_concepts?.length ? unit.key_concepts : undefined,
    outputLanguage: outline.outputLanguage,
    constraints: outline.constraints,
    ...(previousLectures.length > 0 ? { previousLectures } : {}),
    unitProgress: { index: lectureIndex + 1, total: unit.lectures.length },
  };
}
