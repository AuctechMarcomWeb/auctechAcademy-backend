/**
 * Server-side copy of the sequential-unlock state machine (frontend:
 * src/lib/curriculum.ts). The frontend uses its copy for instant UI; this
 * copy is the source of truth for unlocking lessons, opening quizzes and
 * issuing certificates.
 *
 * Order for every course: for each module → lessons…, [assignment], [quiz].
 * An item is available only when every item before it is complete.
 */

export function flattenCurriculum(course, quizzes, assignments) {
  const items = [];
  let index = 0;
  const modules = [...(course.modules ?? [])].sort((a, b) => a.order - b.order);
  for (const mod of modules) {
    for (const lesson of [...(mod.lessons ?? [])].sort((a, b) => a.order - b.order)) {
      items.push({ kind: "lesson", id: lesson.id, moduleId: mod.id, lesson, index: index++ });
    }
    if (mod.assignmentId) {
      const assignment = assignments.find((a) => a.id === mod.assignmentId);
      if (assignment) items.push({ kind: "assignment", id: assignment.id, moduleId: mod.id, assignment, index: index++ });
    }
    if (mod.quizId) {
      const quiz = quizzes.find((q) => q.id === mod.quizId);
      if (quiz) items.push({ kind: "quiz", id: quiz.id, moduleId: mod.id, quiz, index: index++ });
    }
  }
  return items;
}

const isLessonComplete = (lessonId, progress) => Boolean(progress?.lessons?.[lessonId]?.completed);
const isQuizPassed = (quizId, attempts) => attempts.some((a) => a.quizId === quizId && a.passed);
const attemptsUsed = (quizId, attempts) => attempts.filter((a) => a.quizId === quizId).length;
const isAssignmentComplete = (assignmentId, submissions) =>
  submissions.some((s) => s.assignmentId === assignmentId && s.status !== "pending" && s.status !== "rejected");

export function bestAttempt(quizId, attempts) {
  return attempts.filter((a) => a.quizId === quizId).sort((a, b) => b.scorePercent - a.scorePercent)[0];
}

export function isItemComplete(item, ctx) {
  if (item.kind === "lesson") return isLessonComplete(item.lesson.id, ctx.progress);
  if (item.kind === "quiz") return isQuizPassed(item.quiz.id, ctx.attempts);
  return isAssignmentComplete(item.assignment.id, ctx.submissions);
}

/** Map itemId → "locked" | "available" | "in_progress" | "completed". */
export function computeLockStates(ctx) {
  const items = flattenCurriculum(ctx.course, ctx.quizzes, ctx.assignments);
  const states = new Map();
  let previousComplete = true;
  for (const item of items) {
    const complete = isItemComplete(item, ctx);
    if (complete) states.set(item.id, "completed");
    else if (previousComplete) {
      const started =
        item.kind === "lesson"
          ? (ctx.progress?.lessons?.[item.lesson.id]?.maxPosition ?? 0) > 0
          : item.kind === "quiz"
            ? attemptsUsed(item.quiz.id, ctx.attempts) > 0
            : false;
      states.set(item.id, started ? "in_progress" : "available");
    } else states.set(item.id, "locked");
    previousComplete = previousComplete && complete;
  }
  return states;
}

export function summarizeCourse(ctx) {
  const { course, quizzes, assignments, progress, attempts } = ctx;
  const items = flattenCurriculum(course, quizzes, assignments);
  const lessons = items.filter((i) => i.kind === "lesson");
  const quizItems = items.filter((i) => i.kind === "quiz");
  const assignmentItems = items.filter((i) => i.kind === "assignment");

  const bestScores = quizItems.map((q) => bestAttempt(q.id, attempts)?.scorePercent).filter((s) => typeof s === "number");
  const averageQuizScore = bestScores.length ? Math.round(bestScores.reduce((a, b) => a + b, 0) / bestScores.length) : 0;
  const completedItems = items.filter((i) => isItemComplete(i, ctx)).length;
  const finalModule = (course.modules ?? []).find((m) => m.isFinalAssessment);
  const finalQuiz = finalModule?.quizId ? bestAttempt(finalModule.quizId, attempts) : undefined;

  return {
    totalLessons: lessons.length,
    completedLessons: lessons.filter((l) => isItemComplete(l, ctx)).length,
    totalQuizzes: quizItems.length,
    passedQuizzes: quizItems.filter((q) => isItemComplete(q, ctx)).length,
    totalAssignments: assignmentItems.length,
    submittedAssignments: assignmentItems.filter((a) => isItemComplete(a, ctx)).length,
    averageQuizScore,
    percent: items.length ? Math.round((completedItems / items.length) * 100) : 0,
    finalAssessmentScore: finalQuiz?.scorePercent,
    allRequirementsMet: items.length > 0 && completedItems === items.length,
  };
}

export function findLesson(course, lessonId) {
  for (const m of course.modules ?? []) {
    const lesson = (m.lessons ?? []).find((l) => l.id === lessonId);
    if (lesson) return { module: m, lesson };
  }
  return undefined;
}
