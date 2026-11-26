import { gql } from "@salesforce/platform-sdk";

export const CREATE_CUSTOMER = gql`
  mutation CreateCustomer {
    uiapi(input: { allOrNone: true }) {
      Customer__cCreate(input: { Customer__c: { Nickname__c: "New", Email__c: "x@y.z" } }) {
        Record { Id Created_Flag__c { value } }
      }
    }
  }
`;

export const UPDATE_ORDER = gql`
  mutation UpdateOrder($input: Order__cUpdateInput!) {
    uiapi(input: { allOrNone: true }) {
      Order__cUpdate(input: $input) { Record { Id } }
    }
  }
`;

export const DELETE_INVOICE = `
  mutation DeleteInvoice($input: RecordDeleteInput!) {
    uiapi(input: { allOrNone: true }) {
      Invoice__cDelete(input: $input) { Id }
    }
  }
`;
