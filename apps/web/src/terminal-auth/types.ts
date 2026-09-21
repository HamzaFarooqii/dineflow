export interface Employee {
  id: string
  name: string
  role: 'cashier' | 'manager'
  permission_version: number
  locked_until: string | null
  verifier: { version: 1; algorithm: 'PBKDF2-SHA256'; iterations: 600000; salt: string; hash: string }
}
export interface CashierSession {
  employee_id: string
  permission_version: number
  logged_in_at: string
  last_server_validated_at: string
}
export interface Projection {
  device: { id: string; store_id: string; name: string; receipt_prefix: string }
  validated_at: string
  locked_until: string | null
  employees: Employee[]
  session?: CashierSession
}
export interface ManagedEmployee { id: string; name: string; role: 'cashier' | 'manager'; active: boolean; permission_version: number }
export interface ManagedDevice { id: string; name: string; receipt_prefix: string; created_at: string; revoked_at: string | null }
export interface Management { employees: ManagedEmployee[]; devices: ManagedDevice[] }
