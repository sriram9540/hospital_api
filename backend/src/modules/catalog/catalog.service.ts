import { db } from '../../lib/db.js';
import { notFound, AppError } from '../../lib/errors.js';

export interface Department {
  id: string;
  name: string;
  description: string;
  icon?: string;
  isActive: boolean;
  doctorCount?: number;
}

export interface Doctor {
  id: string;
  userId?: string;
  departmentId: string;
  departmentName?: string;
  name: string;
  specialization: string;
  slotMinutes: number;
  overbookLimit: number;
  imageUrl?: string;
  isActive: boolean;
}

export class CatalogService {
  async getDepartments(): Promise<Department[]> {
    const res = await db.query(`
      SELECT d.id, d.name, d.description, d.icon, d.is_active as "isActive",
             COUNT(doc.id)::int as "doctorCount"
      FROM departments d
      LEFT JOIN doctors doc ON doc.department_id = d.id AND doc.is_active = TRUE
      WHERE d.is_active = TRUE
      GROUP BY d.id
      ORDER BY d.name ASC
    `);
    return res.rows;
  }

  async getDepartmentById(id: string): Promise<Department> {
    const res = await db.query(
      `SELECT id, name, description, icon, is_active as "isActive"
       FROM departments WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) {
      notFound('Department not found');
    }
    return res.rows[0];
  }

  async getDoctors(departmentId?: string): Promise<Doctor[]> {
    let query = `
      SELECT doc.id, doc.user_id as "userId", doc.department_id as "departmentId",
             d.name as "departmentName", doc.name, doc.specialization,
             doc.slot_minutes as "slotMinutes", doc.overbook_limit as "overbookLimit",
             doc.image_url as "imageUrl", doc.is_active as "isActive"
      FROM doctors doc
      JOIN departments d ON d.id = doc.department_id
      WHERE doc.is_active = TRUE
    `;
    const params: any[] = [];
    if (departmentId) {
      params.push(departmentId);
      query += ` AND doc.department_id = $1`;
    }
    query += ` ORDER BY doc.name ASC`;

    const res = await db.query(query, params);
    return res.rows;
  }

  async getDoctorById(id: string): Promise<Doctor> {
    const res = await db.query(
      `SELECT doc.id, doc.user_id as "userId", doc.department_id as "departmentId",
              d.name as "departmentName", doc.name, doc.specialization,
              doc.slot_minutes as "slotMinutes", doc.overbook_limit as "overbookLimit",
              doc.image_url as "imageUrl", doc.is_active as "isActive"
       FROM doctors doc
       JOIN departments d ON d.id = doc.department_id
       WHERE doc.id = $1`,
      [id]
    );
    if (res.rows.length === 0) {
      notFound('Doctor not found');
    }
    return res.rows[0];
  }

  async getDoctorSchedule(doctorId: string): Promise<any[]> {
    const doc = await this.getDoctorById(doctorId);
    const res = await db.query(
      `SELECT id, doctor_id as "doctorId", weekday, start_time as "startTime", end_time as "endTime"
       FROM doctor_schedules
       WHERE doctor_id = $1
       ORDER BY weekday ASC`,
      [doctorId]
    );
    return res.rows;
  }

  async createDepartment(data: { name: string; description?: string; icon?: string }): Promise<Department> {
    const res = await db.query(
      `INSERT INTO departments (name, description, icon, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, name, description, icon, is_active as "isActive"`,
      [data.name, data.description || '', data.icon || 'Heart']
    );
    return res.rows[0];
  }

  async createDoctor(data: {
    departmentId: string;
    name: string;
    specialization: string;
    slotMinutes?: number;
    overbookLimit?: number;
  }): Promise<Doctor> {
    await this.getDepartmentById(data.departmentId);
    const res = await db.query(
      `INSERT INTO doctors (department_id, name, specialization, slot_minutes, overbook_limit, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, department_id as "departmentId", name, specialization, slot_minutes as "slotMinutes", overbook_limit as "overbookLimit", is_active as "isActive"`,
      [data.departmentId, data.name, data.specialization, data.slotMinutes || 30, data.overbookLimit || 0]
    );
    return res.rows[0];
  }

  async createSchedule(data: { doctorId: string; weekday: number; startTime: string; endTime: string }): Promise<any> {
    await this.getDoctorById(data.doctorId);
    const res = await db.query(
      `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING id, doctor_id as "doctorId", weekday, start_time as "startTime", end_time as "endTime"`,
      [data.doctorId, data.weekday, data.startTime, data.endTime]
    );
    return res.rows[0];
  }
}

export const catalogService = new CatalogService();
