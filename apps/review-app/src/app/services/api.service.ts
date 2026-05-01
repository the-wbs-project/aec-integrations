import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  IntegrationSummary,
  PaginatedResponse,
  Product,
  ProductDetail,
  Vendor,
  VendorDetail,
  MetaResponse,
  CreateProductRequest,
  UpdateProductRequest,
  CreateVendorRequest,
  CreateVendorResponse,
  UpdateVendorRequest,
  StatsResponse,
} from '../types';

export interface ProductQueryParams {
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

export interface IntegrationQueryParams {
  offset?: number;
  limit?: number;
  search?: string;
  sourceProduct?: string;
  targetProduct?: string;
  poweredByProduct?: string;
  mechanismKind?: string;
  maturity?: string;
  pricingModel?: string;
  builtBy?: string;
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

  getProducts(params?: ProductQueryParams): Observable<PaginatedResponse<Product>> {
    return this.http.get<PaginatedResponse<Product>>(`${this.baseUrl}/tools`, {
      params: this.buildParams(params as Record<string, unknown>),
    });
  }

  getProduct(id: string): Observable<ProductDetail> {
    return this.http.get<ProductDetail>(`${this.baseUrl}/tools/${id}`);
  }

  createProduct(body: CreateProductRequest): Observable<Product> {
    return this.http.post<Product>(`${this.baseUrl}/tools`, body);
  }

  updateProduct(id: string, patch: UpdateProductRequest): Observable<ProductDetail> {
    return this.http.patch<ProductDetail>(`${this.baseUrl}/tools/${id}`, patch);
  }

  getIntegrations(
    params?: IntegrationQueryParams,
  ): Observable<PaginatedResponse<IntegrationSummary>> {
    return this.http.get<PaginatedResponse<IntegrationSummary>>(
      `${this.baseUrl}/integrations`,
      { params: this.buildParams(params as Record<string, unknown>) },
    );
  }

  getIntegration(id: string): Observable<IntegrationSummary> {
    return this.http.get<IntegrationSummary>(
      `${this.baseUrl}/integrations/${id}`,
    );
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

  createVendor(body: CreateVendorRequest): Observable<CreateVendorResponse> {
    return this.http.post<CreateVendorResponse>(
      `${this.baseUrl}/vendors`,
      body,
    );
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
