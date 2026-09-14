import type { ClassSession, ExamSession, Grade, GpaSummary, NewsItem, Student, Term, TuitionStatus } from "@hyeboard/schemas";
import type { StudentHubBill, StudentHubClassSession, StudentHubExam, StudentHubGpa, StudentHubGrade, StudentHubNews, StudentHubStudent, StudentHubTerm } from "@hyeboard/university-adapters/src/uet/types";
import { mapStudent, mapStudentHubClass, mapStudentHubExam, mapStudentHubGpa, mapStudentHubGrade, mapStudentHubNews, mapTerm, mapTuition } from "@hyeboard/university-adapters/src/uet/mapper";
import type { AuthenticatedRequest } from "./vnu-client";

function queryString(termCode?: string): string {
  return termCode ? `?${new URLSearchParams({ termCode })}` : "";
}

export function createUetClient(request: AuthenticatedRequest) {
  const raw = <T>(resource: string, termCode?: string): Promise<T> => request<T>(`/api/uet/raw/${resource}${queryString(termCode)}`);

  return {
    profile: async (): Promise<Student> => mapStudent(await raw<StudentHubStudent>("profile")),
    terms: async (): Promise<Term[]> => (await raw<StudentHubTerm[]>("terms")).map(mapTerm),
    timetable: async (termCode?: string): Promise<ClassSession[]> => (await raw<StudentHubClassSession[]>("timetable", termCode)).map(mapStudentHubClass),
    grades: async (): Promise<Grade[]> => (await raw<StudentHubGrade[]>("grades")).map(mapStudentHubGrade),
    gpa: async (): Promise<GpaSummary> => mapStudentHubGpa(await raw<StudentHubGpa>("gpa")),
    exams: async (termCode?: string): Promise<ExamSession[]> => (await raw<StudentHubExam[]>("exams", termCode)).map(mapStudentHubExam),
    tuition: async (): Promise<TuitionStatus> => mapTuition(await raw<StudentHubBill[]>("tuition")),
    news: async (): Promise<NewsItem[]> => (await raw<StudentHubNews[]>("news")).map(mapStudentHubNews),
  };
}
