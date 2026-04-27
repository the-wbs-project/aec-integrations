import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  PaginatedResponse,
  Tool,
  ToolDetail,
  Vendor,
  VendorDetail,
  MetaResponse,
  CreateToolRequest,
  UpdateToolRequest,
  UpdateVendorRequest,
  StatsResponse,
} from '../types';

export interface ToolQueryParams {
  offset?: number;
  limit?: number;
  search?: string;
  category?: string;
  discipline?: string;
  phase?: string;
  status?: string;
  tier?: string;
  enrichmentStatus?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

export interface VendorQueryParams {
  offset?: number;
  limit?: number;
  search?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = '/api';

  getTools(params?: ToolQueryParams): Observable<PaginatedResponse<Tool>> {
    return this.http.get<PaginatedResponse<Tool>>(`${this.baseUrl}/tools`, {
      params: this.buildParams(params as Record<string, unknown>),
    });
  }

  getTool(id: string): Observable<ToolDetail> {
    return this.http.get<ToolDetail>(`${this.baseUrl}/tools/${id}`);
  }

  createTool(body: CreateToolRequest): Observable<Tool> {
    return this.http.post<Tool>(`${this.baseUrl}/tools`, body);
  }

  updateTool(id: string, patch: UpdateToolRequest): Observable<ToolDetail> {
    return this.http.patch<ToolDetail>(`${this.baseUrl}/tools/${id}`, patch);
  }

  getVendors(
    params?: VendorQueryParams
  ): Observable<PaginatedResponse<Vendor>> {
    return this.http.get<PaginatedResponse<Vendor>>(
      `${this.baseUrl}/vendors`,
      { params: this.buildParams(params as Record<string, unknown>) }
    );
  }

  getVendor(id: string): Observable<VendorDetail> {
    return this.http.get<VendorDetail>(`${this.baseUrl}/vendors/${id}`);
  }

  updateVendor(id: string, patch: UpdateVendorRequest): Observable<VendorDetail> {
    return this.http.patch<VendorDetail>(`${this.baseUrl}/vendors/${id}`, patch);
  }

  getMeta(): Observable<MetaResponse> {
    return this.http.get<MetaResponse>(`${this.baseUrl}/meta`);
  }

  getStats(): Observable<StatsResponse> {
    return this.http.get<StatsResponse>(`${this.baseUrl}/stats`);
  }

  private buildParams(params?: Record<string, unknown>): HttpParams {
    let httpParams = new HttpParams();
    if (!params) return httpParams;

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return httpParams;
  }
}
