import { createDataSDK, gql } from "@salesforce/platform-sdk";

const CUSTOMER_FIELDS = gql`
  fragment CustomerFields on Customer__c {
    Tier__c @optional { value displayValue }
  }
`;

export const GET_CUSTOMERS = gql`
  query GetCustomers($first: Int, $after: String) {
    uiapi {
      query {
        Customer__c(
          first: $first
          after: $after
          where: { OR: [{ Status__c: { eq: "Active" } }, { Region__c: { like: "EU%" } }] }
          orderBy: { Sort_Key__c: { order: ASC } }
        ) {
          edges {
            node {
              Id
              Email__c @optional { value }
              ...CustomerFields
              Owner @optional { Name @optional { value } }
              Orders__r(first: 5) @optional {
                edges { node { Amount__c @optional { value } } }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
  ${CUSTOMER_FIELDS}
`;

export async function loadCustomers(): Promise<unknown> {
  const sdk = await createDataSDK();
  return sdk.graphql!.query({ query: GET_CUSTOMERS, variables: { first: 20 } });
}

// Plain text that is not a query: Customer__c.Not_A_Field__c
export const HELP = "Ask your admin about Customer__c { Fake__c }";
