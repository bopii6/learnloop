// 课程大纲的前端缓存：课程页拿到的大纲，进课堂 / 回课程页时直接用，先出画面再后台刷新。
// 内存一份（同一标签页内跳转零等待）+ sessionStorage 一份（刷新页面后仍可秒开）。
import type { CourseOutline } from "@/types";

interface Entry {
  outline: CourseOutline;
  visited?: string[];
}

const mem = new Map<string, Entry>();
const KEY = (id: string) => `ll:course:${id}`;

export function readCourseCache(id: string): Entry | null {
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const raw = window.sessionStorage.getItem(KEY(id));
    if (!raw) return null;
    const e = JSON.parse(raw) as Entry;
    if (!e?.outline?.units) return null;
    mem.set(id, e);
    return e;
  } catch {
    return null;
  }
}

export function writeCourseCache(id: string, e: Entry): void {
  mem.set(id, e);
  try {
    window.sessionStorage.setItem(KEY(id), JSON.stringify(e));
  } catch {
    // 存不下就只留内存
  }
}

/** 悬停 / 预取：提前把大纲拉进缓存（同一课程并发只发一次） */
const inflight = new Map<string, Promise<void>>();
export function prefetchCourse(id: string): Promise<void> {
  if (mem.has(id)) return Promise.resolve();
  const running = inflight.get(id);
  if (running) return running;
  const p = fetch(`/api/courses/${id}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.course?.outline) writeCourseCache(id, { outline: d.course.outline, visited: d.visited || [] });
    })
    .catch(() => {})
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
