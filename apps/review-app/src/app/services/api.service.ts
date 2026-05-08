import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  PaginatedResponse,
  Product,
  ProductDetail,
  Vendor,
  VendorDetail,
  MetaResponse,
  CreateProductRequest,
  CreateProductResponse,
  UpdateProductRequest,
  CreateVendorRequest,
  CreateVendorResponse,
  UpdateVendorRequest,
  StatsResponse,
  PlaybookSummary,
  EnqueuePromptJobRequest,
  EnqueuePromptJobResponse,
  AeciSearchRequest,
  AeciSearchResponse,
  AeciSearchSyncRequest,
  AeciSearchSyncResponse,
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
  includeRejected?: boolean;
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
    return this.http.get<PaginatedResponse<Product>>(`${this.baseUrl}/products`, {
      params: this.buildParams(params as Record<string, unknown>),
    });
  }

  getProduct(id: string): Observable<ProductDetail> {
    return this.http.get<ProductDetail>(`${this.baseUrl}/products/${id}`);
  }

  createProduct(body: CreateProductRequest): Observable<CreateProductResponse> {
    return this.http.post<CreateProductResponse>(
      `${this.baseUrl}/products`,
      body,
    );
  }

  updateProduct(id: string, patch: UpdateProductRequest): Observable<ProductDetail> {
    return this.http.patch<ProductDetail>(`${this.baseUrl}/products/${id}`, patch);
  }

  rescoreProduct(id: string): Observable<{ summary: string; product: ProductDetail }> {
    return this.http.post<{ summary: string; product: ProductDetail }>(
      `${this.baseUrl}/products/${id}/rescore`,
      {},
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

  deleteVendor(id: string): Observable<{ deleted: boolean; id: string }> {
    return this.http.delete<{ deleted: boolean; id: string }>(
      `${this.baseUrl}/vendors/${id}`,
    );
  }

  getMeta(): Observable<MetaResponse> {
    return this.http.get<MetaResponse>(`${this.baseUrl}/meta`);
  }

  getStats(): Observable<StatsResponse> {
    return this.http.get<StatsResponse>(`${this.baseUrl}/stats`);
  }

  getPlaybooks(): Observable<PlaybookSummary[]> {
    return this.http.get<PlaybookSummary[]>(`${this.baseUrl}/playbooks`);
  }

  enqueuePromptJob(
    body: EnqueuePromptJobRequest,
  ): Observable<EnqueuePromptJobResponse> {
    return this.http.post<EnqueuePromptJobResponse>(
      `${this.baseUrl}/prompt-queue`,
      body,
    );
  }

  searchAeciCorpus(body: AeciSearchRequest): Observable<AeciSearchResponse> {
    return this.http.post<AeciSearchResponse>(`${this.baseUrl}/search`, body);
  }

  syncAeciSearch(body: AeciSearchSyncRequest): Observable<AeciSearchSyncResponse> {
    return this.http.post<AeciSearchSyncResponse>(
      `${this.baseUrl}/search/sync`,
      body,
    );
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
