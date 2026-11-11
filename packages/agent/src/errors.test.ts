import { describe, expect, test } from 'bun:test'

import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'

import { BudgetExceededError, budgetExceededFrom } from './errors.ts'

const apiError = (statusCode: number, responseBody: string, message = 'request failed') =>
  new APICallError({
    message,
    url: 'https://llm.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseBody,
  })

describe('budgetExceededFrom', () => {
  test('HTTP 402 is always a budget refusal', () => {
    expect(budgetExceededFrom(apiError(402, 'Insufficient credits'))).toMatchObject({
      name: 'BudgetExceededError',
      httpStatus: 402,
    })
  })

  test('known budget codes count at any status', () => {
    const error = budgetExceededFrom(
      apiError(429, '{"error":{"code":"api_key_limit_exceeded","message":"Weekly limit reached"}}'),
    )
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({ httpStatus: 429, code: 'api_key_limit_exceeded' })
    expect(budgetExceededFrom(apiError(429, '{"error":{"code":"insufficient_quota"}}'))?.code).toBe(
      'insufficient_quota',
    )
  })

  test('budget wording counts on 400, 403 and 429', () => {
    expect(
      budgetExceededFrom(apiError(400, 'Your credit balance is too low to access the API')),
    ).toBeInstanceOf(BudgetExceededError)
    expect(budgetExceededFrom(apiError(429, '', 'Monthly spend limit reached'))).toBeInstanceOf(
      BudgetExceededError,
    )
    expect(budgetExceededFrom(new Error('Budget has been exceeded for key'))).toBeInstanceOf(
      BudgetExceededError,
    )
  })

  test('rate limits and other failures stay as they are', () => {
    expect(budgetExceededFrom(apiError(429, 'Too many requests, slow down'))).toBeUndefined()
    expect(budgetExceededFrom(apiError(500, 'spend limit reached'))).toBeUndefined()
    expect(budgetExceededFrom(new Error('boom'))).toBeUndefined()
    expect(budgetExceededFrom('text')).toBeUndefined()
  })

  test('looks through retries and causes', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(429, 'rate limited'), apiError(402, 'Payment required')],
    })
    expect(budgetExceededFrom(retry)?.httpStatus).toBe(402)
    const wrapped = new Error('run failed', { cause: apiError(402, '') })
    expect(budgetExceededFrom(wrapped)?.cause).toBe(wrapped)
  })
})
