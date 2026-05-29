# Sample AI Test Generation Prompts

These are example natural language prompts you can type into the Autotest extension to generate Playwright tests. Navigate to the target website first, then type the prompt.

---

## Login & Authentication

### Basic Login Test
```
Test the login form with valid credentials. Enter "user@example.com" as email
and "Password123" as password, click Sign In, and verify the dashboard loads.
```

### Invalid Login Test
```
Test the login form with invalid credentials. Enter "wrong@email.com" as email
and "badpassword" as password, click Sign In, and verify an error message
"Invalid email or password" appears.
```

### Empty Form Validation
```
Click the Sign In button without entering any credentials. Verify that
validation error messages appear for both the email and password fields.
```

### Logout Flow
```
Log in with valid credentials, then find and click the logout button or
user menu → Sign Out. Verify the user is redirected back to the login page.
```

---

## Form Interactions

### Registration Form
```
Fill the registration form with: first name "John", last name "Doe",
email "john.doe@example.com", password "SecurePass123!", confirm password
"SecurePass123!". Click Register and verify a success message appears.
```

### Search Functionality
```
Type "Playwright testing" in the search bar and press Enter. Verify that
search results appear and at least one result contains the word "Playwright".
```

### Contact Form
```
Fill the contact form with name "Jane Smith", email "jane@test.com",
subject "Test Inquiry", and message "This is an automated test message."
Click Submit and verify a confirmation message appears.
```

### Dropdown & Select
```
Open the category dropdown, select "Electronics", then open the sort dropdown
and select "Price: Low to High". Verify the product list refreshes with
electronics items sorted by price.
```

---

## Navigation & Multi-Step Flows

### E-Commerce Checkout Flow
```
Search for "laptop", click on the first product result, click "Add to Cart",
go to the cart page, verify the item is in the cart, then proceed to checkout.
Verify the checkout form is displayed with shipping address fields.
```

### Multi-Page Navigation
```
Click the "Products" link in the navigation bar. On the products page,
click the first product card. Verify the product detail page loads with
a title, price, and "Add to Cart" button visible.
```

### Pagination
```
Navigate to the products listing page. Click "Next" or page "2" in the
pagination. Verify the URL changes and new products are displayed.
Then click "Previous" and verify page 1 loads again.
```

---

## Assertions & Validation

### Content Verification
```
Navigate to the homepage. Verify the page title contains "Welcome".
Verify a hero banner image is visible. Verify the navigation bar contains
links for "Home", "Products", "About", and "Contact".
```

### Responsive Layout Check
```
Check that the main navigation menu is visible on desktop. Verify the
footer contains copyright text with the current year.
```

### Error Handling
```
Navigate to a non-existent page "/this-page-does-not-exist". Verify a
404 error page is displayed with a "Go Back Home" link.
```

---

## API-Heavy Pages

### Data Table
```
Navigate to the users list page. Verify a table with columns "Name",
"Email", "Role" is displayed. Verify there are at least 5 rows in the table.
Click the "Name" column header to sort and verify the order changes.
```

### Infinite Scroll / Load More
```
Scroll to the bottom of the feed page. Verify that new content loads
automatically or a "Load More" button appears. Click it if present and
verify additional items are added to the list.
```

---

## Tips for Writing Effective Prompts

1. **Be specific about selectors**: Use visible text, labels, or placeholders rather than CSS classes
   - Good: `Click the "Sign In" button`
   - Less ideal: `Click the .btn-primary element`

2. **Include verification steps**: Always add what to verify after an action
   - Good: `Click Submit and verify a success message appears`
   - Less ideal: `Click Submit`

3. **Describe the flow sequentially**: Write steps in the order they should execute

4. **Use real-looking test data**: Provide realistic values for form fields

5. **Keep prompts focused**: One flow per prompt works best. Split complex scenarios into multiple tests.
